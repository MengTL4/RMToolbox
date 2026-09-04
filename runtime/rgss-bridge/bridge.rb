# RMCH bridge for RGSS games (RPG Maker XP / VX / VX Ace).
#
# Appended to the game's Scripts archive, so it is evaluated before the entry
# that calls rgss_main. It must stay Ruby 1.8.1 compatible: RGSS1 and RGSS2 run
# Ruby 1.8.1, only RGSS3 runs 1.9.2.
#
# Wiring notes learned the hard way:
#   * Pumping happens from a hook on the scene update loop, not a thread.
#     Ruby 1.8.1 uses green threads and the engine's main loop would starve one.
#   * Graphics.update is a C function, so a Ruby-level alias is bypassed.
#     Scene_Base#update (VX/Ace) is plain Ruby; XP has no Scene_Base, so every
#     Scene_* class that defines its own update gets hooked instead.
#   * The database is not loaded while entries are evaluated, so every read has
#     to happen at request time.
#   * RGSS ships a stripped-down Ruby: `require "socket"` raises LoadError on
#     every version. Win32API can reach ws2_32 (verified working on all three
#     versions, including recv readback), but a blocking recv would freeze the
#     game loop, so the channel is a pair of append-only files instead.
#     Latency is one frame, which is plenty here.
#
# Transport: two append-only files in the shadow directory.
#   rmch-cmd.jsonl  Node -> bridge, one JSON request per line
#   rmch-res.jsonl  bridge -> Node, one JSON response per line
# Both sides track how far they have read, so nothing is ever deleted or
# rewritten and there is no lock contention.
#
# Requests look like   {"t":"cmd","id":N,"type":"...","args":{...}}
# responses like       {"t":"result","id":N,"ok":true,"payload":...}
# plus an unsolicited  {"t":"hello",...} on the first pump and a periodic
# {"t":"state",...} push (once a second and after every command).
#
# The command vocabulary mirrors the MV/MZ bridge (runtime/bridge/src/parts),
# so the GUI talks to both engines unchanged. Commands RGSS cannot serve raise
# "unsupported on RGSS", which the GUI degrades gracefully.

module RMCH
  VERSION = "0.4.0"
  # "RGSS1" / "RGSS2" / "RGSS3", patched in by the injector.
  GENERATION = "__RMCH_GENERATION__"

  @inbuf = ""
  @started = false
  @stopped = false
  @port = 0
  @token = ""
  @game_key = ""
  @real_dir = ""
  @frames = 0
  @options = nil
  @value_locks = nil
  @hook_targets = nil
  @hooks_done = false
  @suppress = 0
  @lock_apply_count = 0
  # Tracking for pump-enforced options, so turning one off restores the value
  # the game had before we started forcing it.
  @through_forced = false
  @encounter_forced = false
  @speed_written = false
  @speed_written_value = 0
  @speed_written_base = 0
  @speed_applied = false
  @base_frame_rate = 0

  class << self
    attr_reader :started

    # --- configuration (patched in by the injector) -------------------------
    # channel_dir: where the rmch-cmd/rmch-res.jsonl channel files live.
    # Empty means Dir.pwd (the shadow root on launch; used by core/attach.mjs
    # with a real directory so attaching never writes into the game folder).
    def configure(port, token, game_key, real_dir = "", channel_dir = "")
      @port = port
      @token = token
      @game_key = game_key
      @real_dir = real_dir
      @channel_dir = channel_dir
    end

    def rgss3?
      GENERATION == "RGSS3"
    end

    def rgss1?
      GENERATION == "RGSS1"
    end

    def rgss2?
      GENERATION == "RGSS2"
    end

    def suppressed?
      @suppress > 0
    end

    # Engine writes we make ourselves (vitals.set, lock ticks) must not be
    # re-clamped by our own hooks.
    def with_suppression
      @suppress += 1
      begin
        yield
      ensure
        @suppress -= 1
      end
    end

    # --- JSON writer --------------------------------------------------------
    # Ruby 1.8.1 ships no JSON, so encode just the shapes we emit.
    def jstr(str)
      out = '"'
      str.to_s.each_byte do |b|
        c = b.chr
        if c == '"'
          out << '\\"'
        elsif c == '\\'
          out << '\\\\'
        elsif c == "\n"
          out << '\\n'
        elsif c == "\r"
          out << '\\r'
        elsif c == "\t"
          out << '\\t'
        elsif b < 32
          out << sprintf('\\u%04x', b)
        else
          out << c
        end
      end
      out << '"'
      out
    end

    def jenc(value)
      case value
      when nil then "null"
      when true then "true"
      when false then "false"
      when Integer, Float then value.to_s
      when String then jstr(value)
      when Symbol then jstr(value.to_s)
      when Array
        "[" + value.map { |v| jenc(v) }.join(",") + "]"
      when Hash
        "{" + value.map { |k, v| jstr(k.to_s) + ":" + jenc(v) }.join(",") + "}"
      else
        jstr(value.to_s)
      end
    end

    # --- transport ----------------------------------------------------------
    # Files live next to the game exe inside the shadow copy, so they disappear
    # with it. Offsets let each side read only what is new.
    def connect
      return false if @started || @stopped
      begin
        channel_root = (@channel_dir.nil? || @channel_dir.empty?) ? Dir.pwd : @channel_dir
        @cmd_path = File.join(channel_root, "rmch-cmd.jsonl")
        @res_path = File.join(channel_root, "rmch-res.jsonl")
        @cmd_offset = 0
        @frames = 0
        # Starting fresh: truncate both channels so stale ids cannot confuse us.
        File.open(@cmd_path, "wb") { |f| f.write("") }
        File.open(@res_path, "wb") { |f| f.write("") }
        @started = true
        # All game scripts are already evaluated at this point (the bridge is
        # appended just before Main), so every class is hookable now.
        install_hooks
        send_frame("hello", {
          "version" => VERSION,
          "token" => @token,
          "gameKey" => @game_key,
          "engine" => engine_label,
          "ruby" => RUBY_VERSION
        })
        # A state failure must not take the bridge down with it — report and
        # stay connected.
        begin
          push_state
        rescue Exception => e
          send_frame("event", { "kind" => "error",
            "message" => "state push: " + e.class.to_s + ": " + e.message.to_s })
        end
        true
      rescue Exception => e
        @started = false
        @last_error = e.class.to_s + ": " + e.message.to_s
        false
      end
    end

    def engine_label
      "#{RUBY_VERSION}/#{GENERATION.downcase}"
    end

    def send_frame(type, extra)
      return unless @started
      frame = { "t" => type }
      extra.each { |k, v| frame[k] = v } if extra
      begin
        File.open(@res_path, "ab") { |f| f.write(jenc(frame) + "\n") }
      rescue Exception
        stop
      end
    end

    def stop
      @stopped = true
      @started = false
    end

    # A scene update exception escapes SceneManager.run and kills the game (and
    # therefore the bridge). Report it — once per distinct message — so the
    # failure is visible instead of a silent command timeout.
    def report_game_error(error)
      key = error.class.to_s + ": " + error.message.to_s
      @reported_errors ||= {}
      return if @reported_errors[key]
      @reported_errors[key] = true
      send_frame("event", { "kind" => "game-error", "message" => key,
        "backtrace" => (error.backtrace || []).first(6).join(" <- ") })
    rescue Exception
    end

    # Called once per frame from the scene update hook.
    def pump
      return unless @started
      begin
        @frames += 1
        # Per-frame enforcement: world options, vitals locks and value locks
        # re-assert themselves so the game cannot undo them between frames.
        apply_world_options
        apply_game_speed
        apply_vitals_locks
        apply_value_locks
        # Live push for the GUI's status bar (gold / map / party), about once
        # a second at 60fps.
        push_state if @frames % 60 == 0
        return unless File.exist?(@cmd_path)
        size = File.size(@cmd_path)
        return if size <= @cmd_offset
        chunk = ""
        File.open(@cmd_path, "rb") do |f|
          f.seek(@cmd_offset)
          chunk = f.read(size - @cmd_offset).to_s
        end
        @cmd_offset = size
        @inbuf << chunk
        while (idx = @inbuf.index("\n"))
          line = @inbuf.slice!(0, idx + 1).chomp
          handle_line(line)
        end
      rescue Exception => e
        begin
          send_frame("event", { "kind" => "error", "message" => e.class.to_s + ": " + e.message.to_s })
        rescue Exception
        end
      end
    end

    # --- request parsing ----------------------------------------------------
    # Full JSON parsing is overkill; requests are flat objects we can scan for.
    def handle_line(line)
      return if line.nil? || line.empty?
      type = json_field(line, "type")
      id = json_field(line, "id")
      id_num = id ? id.to_i : 0
      return unless type
      args = parse_args(line)
      begin
        payload = dispatch(type, args, line)
        send_frame("result", { "id" => id_num, "ok" => true, "payload" => payload })
      rescue Exception => e
        send_frame("result", {
          "id" => id_num,
          "ok" => false,
          "error" => e.class.to_s + ": " + e.message.to_s
        })
      end
      begin
        push_state
      rescue Exception
      end
    end

    # Pull a top-level string/number field out of a flat JSON object.
    def json_field(line, key)
      return nil unless line.index('"t"')
      m = Regexp.new('"' + Regexp.escape(key) + '"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"').match(line)
      return unescape(m[1]) if m
      m2 = Regexp.new('"' + Regexp.escape(key) + '"\\s*:\\s*(-?[0-9.eE+]+)').match(line)
      return m2[1] if m2
      nil
    end

    def unescape(str)
      # Index-based scanning keeps this fast on multi-MB payloads (the
      # save.contents.apply code string); byte-at-a-time slicing would crawl.
      out = ""
      i = 0
      len = str.length
      while i < len
        j = str.index("\\", i)
        if j.nil?
          out << str[i, len - i]
          break
        end
        out << str[i, j - i]
        n = str[j + 1, 1]
        case n
        when "n" then out << "\n"
        when "t" then out << "\t"
        when "r" then out << "\r"
        when "b" then out << "\b"
        when "f" then out << "\f"
        when "/" then out << "/"
        when "\\" then out << "\\"
        when '"' then out << '"'
        when "u"
          out << [str[j + 2, 4].to_i(16)].pack("U*")
          j += 4
        else out << n.to_s
        end
        i = j + 2
      end
      out
    end

    # Pull one large string field straight off the raw request line with
    # escape-aware scanning. parse_args/brace_body cannot carry these: braces
    # inside the payload would corrupt the depth count (same reason
    # lock.replace scans the raw line).
    def extract_string_field(line, key)
      m = Regexp.new('"' + Regexp.escape(key) + '"\\s*:\\s*"').match(line)
      return nil unless m
      start = m.end(0)
      i = start
      while true
        j = line.index('"', i)
        return nil unless j
        backslashes = 0
        k = j - 1
        while k >= start && line[k, 1] == "\\"
          backslashes += 1
          k -= 1
        end
        return unescape(line[start, j - start]) if backslashes % 2 == 0
        i = j + 1
      end
    end

    def extract_bool_field(line, key)
      m = Regexp.new('"' + Regexp.escape(key) + '"\\s*:\\s*(true|false)').match(line)
      m ? (m[1] == "true") : nil
    end

    # Body of a balanced {...} block whose opening brace ends at `start`.
    def brace_body(str, start)
      depth = 1
      i = start
      while i < str.length && depth > 0
        c = str[i, 1]
        depth += 1 if c == "{"
        depth -= 1 if c == "}"
        break if depth == 0
        i += 1
      end
      str[start, i - start] || ""
    end

    # Extract the flat "args" object into a {name => string} hash. Booleans and
    # null keep their literal spelling ("true"/"false"/"null") so commands can
    # tell "false" apart from "absent" (nil). The scan runs over the whole args
    # body, so scalar keys nested one level deep (trainer.options.set sends
    # {"options": {...}}) are picked up too.
    def parse_args(line)
      args = {}
      m = Regexp.new('"args"\\s*:\\s*\\{').match(line)
      return args unless m
      body = brace_body(line, m.end(0))
      body.scan(/"([^"\\]*)"\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|(-?[0-9.eE+]+)|(true|false|null))/) do
        key = $1
        if $2
          args[key] = unescape($2)
        elsif $3
          args[key] = $3
        elsif $4
          args[key] = $4
        else
          args[key] = nil
        end
      end
      args
    end

    # lock.replace sends {"locks": {"item": {"3": 99}, ..., "gold": 500}} —
    # two levels of nesting with meaningful keys, which parse_args would
    # flatten away. Scan each known kind's sub-object separately.
    LOCK_KINDS = ["item", "weapon", "armor", "switch", "variable"]

    def parse_locks(line)
      out = {}
      m = /"locks"\s*:\s*\{/.match(line)
      return out unless m
      body = brace_body(line, m.end(0))
      LOCK_KINDS.each do |kind|
        km = Regexp.new('"' + kind + '"\\s*:\\s*\\{').match(body)
        next unless km
        inner = {}
        brace_body(body, km.end(0)).scan(/"(\d+)"\s*:\s*(-?[0-9.eE+]+|true|false|null)/) do
          inner[$1.to_i] = $2
        end
        out[kind] = inner
      end
      gm = /"gold"\s*:\s*(-?[0-9.eE+]+)/.match(body)
      out["gold"] = gm ? gm[1] : nil
      out
    end

    # --- shared guards --------------------------------------------------------
    # RGSS1 builds $game_party only once a game starts; VX/Ace create it up
    # front. Everything touching the party has to cope with the title screen.
    def party!
      party = $game_party
      raise "no save loaded yet: start or continue a game first" unless party
      party
    end

    def require_actor(id)
      actor = $game_actors ? $game_actors[id] : nil
      raise "actor #{id} is unavailable" unless actor
      actor
    end

    def truthy(value)
      s = value.to_s
      s != "" && s != "0" && s != "false" && s != "null"
    end

    def present(value)
      !value.nil? && value.to_s != ""
    end

    # --- data tables ----------------------------------------------------------
    def data_table(kind)
      case kind
      when "item" then $data_items
      when "weapon" then $data_weapons
      when "armor" then $data_armors
      when "skill" then $data_skills
      when "state" then $data_states
      when "actor" then $data_actors
      when "enemy" then $data_enemies
      when "class" then $data_classes
      when "commonEvent" then $data_common_events
      when "troop" then $data_troops
      else nil
      end
    end

    def safe(obj, method)
      return "" unless obj.respond_to?(method)
      value = obj.send(method)
      value.nil? ? "" : value.to_s
    rescue Exception
      ""
    end

    def safe_int(obj, method)
      return 0 unless obj.respond_to?(method)
      value = obj.send(method)
      value.is_a?(Integer) ? value : value.to_i
    rescue Exception
      0
    end

    # First method that exists, as an integer (engines rename accessors:
    # maxhp/mhp, mp/sp, maxmp/maxsp/mmp).
    def first_int(obj, methods)
      methods.each do |method|
        next unless obj.respond_to?(method)
        value = obj.send(method)
        return value.to_i if value
      end
      0
    rescue Exception
      0
    end

    # --- catalog ----------------------------------------------------------------
    def catalog_query(args)
      kind = args["kind"].to_s
      table = data_table(kind)
      raise "unsupported catalog kind: #{kind}" unless table
      query = args["query"].to_s.downcase
      limit = args["limit"] ? args["limit"].to_i : 500
      limit = 500 if limit <= 0
      entries = []
      # Compare queries as raw bytes: modern editors tag database strings
      # UTF-8 while the wire query arrives as untagged bytes, and
      # String#include? across those encodings raises CompatibilityError on
      # Ruby >= 1.9 (武界风云传 RGD/Ruby 3.1.2 实测).
      qb = query.unpack("C*").pack("C*")
      table.each_with_index do |entry, id|
        next if entry.nil? || id == 0
        name = entry.respond_to?(:name) ? entry.name.to_s : ""
        next unless qb.empty? ||
          name.downcase.unpack("C*").pack("C*").include?(qb) || id.to_s == query
        entries << {
          "id" => id,
          "name" => name,
          "iconIndex" => entry.respond_to?(:icon_index) ? entry.icon_index : nil,
          # RGSS1 (XP) has no IconSet sheet — one file per icon under
          # Graphics/Icons/, referenced by name.
          "iconName" => entry.respond_to?(:icon_name) ? entry.icon_name.to_s : nil,
          "note" => entry.respond_to?(:note) ? entry.note.to_s[0, 300] : ""
        }
      end
      total = entries.length
      { "total" => total, "entries" => entries[0, limit] }
    end

    # --- inventory --------------------------------------------------------------
    ITEM_BAG_IVARS = { "item" => "@items", "weapon" => "@weapons", "armor" => "@armors" }

    def item_bag(kind)
      bag = party!.instance_variable_get(ITEM_BAG_IVARS[kind] || "@items")
      bag.is_a?(Hash) ? bag : {}
    end

    def item_count(kind, id)
      bag = item_bag(kind)
      bag[id] ? bag[id].to_i : 0
    end

    def gain_entry(kind, id, amount)
      party = party!
      if rgss3?
        # VX Ace's gain_item takes the data object, not the id.
        table = data_table(kind)
        entry = table ? table[id] : nil
        raise "#{kind} #{id} not found" unless entry
        party.gain_item(entry, amount)
      else
        case kind
        when "weapon" then party.gain_weapon(id, amount)
        when "armor" then party.gain_armor(id, amount)
        else party.gain_item(id, amount)
        end
      end
    end

    def item_list
      entries = []
      ["item", "weapon", "armor"].each do |kind|
        table = data_table(kind)
        item_bag(kind).each_pair do |id, count|
          next if count.to_i <= 0
          entry = table ? table[id] : nil
          entries << {
            "kind" => kind,
            "id" => id,
            "name" => entry ? safe(entry, :name) : "",
            "count" => count.to_i
          }
        end
      end
      entries = entries.sort_by { |e| [e["kind"], e["id"]] } rescue entries
      { "entries" => entries }
    end

    def item_set(args)
      kind = args["kind"].to_s
      kind = "item" unless ITEM_BAG_IVARS[kind]
      id = args["id"].to_i
      raise "id must be positive" if id <= 0
      count = args["count"].to_i
      count = 0 if count < 0
      delta = count - item_count(kind, id)
      gain_entry(kind, id, delta) if delta != 0
      { "kind" => kind, "id" => id, "count" => item_count(kind, id) }
    end

    # --- party / actors ---------------------------------------------------------
    def party_members(party)
      list = party.respond_to?(:members) ? party.members : (party.respond_to?(:actors) ? party.actors : [])
      list || []
    end

    def entry_list(actor, meth, table)
      out = []
      return out unless actor.respond_to?(meth)
      list = actor.send(meth)
      return out unless list.is_a?(Array)
      list.each do |item|
        if item.is_a?(Integer)
          entry = table ? table[item] : nil
          out << { "id" => item, "name" => entry ? entry.name.to_s : "" }
        elsif item && item.respond_to?(:id)
          out << { "id" => item.id, "name" => item.respond_to?(:name) ? item.name.to_s : "" }
        end
      end
      out
    rescue Exception
      []
    end

    def actor_class_name(actor)
      return nil unless actor.respond_to?(:class_id) && $data_classes
      klass = $data_classes[actor.class_id]
      klass ? klass.name.to_s : nil
    rescue Exception
      nil
    end

    def actor_next_exp(actor)
      [:next_level_exp, :next_exp, :next_rest_exp].each do |method|
        next unless actor.respond_to?(method)
        value = actor.send(method)
        return value if value.is_a?(Integer)
      end
      nil
    rescue Exception
      nil
    end

    def actor_params(actor)
      return nil unless actor.respond_to?(:param) # VX Ace only
      out = []
      (0..7).each { |i| out << actor.param(i).to_i }
      out
    rescue Exception
      nil
    end

    # One actor as plain JSON, same shape the MV/MZ bridge emits so the 数据 tab's
    # detail editor works unchanged. Every field is guarded independently.
    def actor_info(actor)
      {
        "id" => safe_int(actor, :id),
        "name" => safe(actor, :name),
        "nickname" => actor.respond_to?(:nickname) ? actor.nickname.to_s : nil,
        "classId" => actor.respond_to?(:class_id) ? actor.class_id : nil,
        "className" => actor_class_name(actor),
        "level" => safe_int(actor, :level),
        "maxLevel" => actor.respond_to?(:max_level) ? actor.max_level : 99,
        "exp" => safe_int(actor, :exp),
        "nextLevelExp" => actor_next_exp(actor),
        "hp" => safe_int(actor, :hp),
        "mhp" => first_int(actor, [:maxhp, :mhp]),
        "mp" => first_int(actor, [:mp, :sp]),
        "mmp" => first_int(actor, [:maxmp, :maxsp, :mmp]),
        "tp" => actor.respond_to?(:tp) ? actor.tp : nil,
        "maxTp" => actor.respond_to?(:max_tp) ? actor.max_tp : nil,
        "params" => actor_params(actor),
        "paramPlus" => nil,
        "skills" => entry_list(actor, :skills, $data_skills),
        "states" => entry_list(actor, :states, $data_states),
        "equips" => entry_list(actor, :equips, nil)
      }
    end

    def party_state
      out = []
      party = $game_party
      return out unless party
      party_members(party).each do |actor|
        out << actor_info(actor)
      end
      out
    end

    def actor_set_level(actor, level)
      level = 1 if level < 1
      if actor.respond_to?(:change_level)
        actor.change_level(level, false)          # VX Ace
      elsif actor.respond_to?(:level=)
        actor.level = level                        # XP
      elsif actor.respond_to?(:change_exp)
        list = actor.instance_variable_get(:@exp_list) # VX has no level writer
        exp = list && list[level] ? list[level] : 0
        actor.change_exp(exp, false)
      else
        raise "level write is unavailable"
      end
    end

    def actor_add_exp(actor, amount)
      if actor.respond_to?(:gain_exp)
        actor.gain_exp(amount)                     # VX Ace
      elsif actor.respond_to?(:change_exp)
        actor.change_exp(safe_int(actor, :exp) + amount, false) # VX
      elsif actor.respond_to?(:exp=)
        actor.exp = safe_int(actor, :exp) + amount # XP
      else
        raise "exp write is unavailable"
      end
    end

    # --- switches / variables ---------------------------------------------------
    def system_names(kind)
      system = $data_system
      raise "$data_system is unavailable" unless system
      kind == "switch" ? system.switches : system.variables
    end

    def flag_store(kind)
      store = kind == "switch" ? $game_switches : $game_variables
      raise "no save loaded yet: start or continue a game first" unless store
      store
    end

    def flag_list(kind, args)
      names = system_names(kind)
      store = flag_store(kind)
      offset = args["offset"] ? args["offset"].to_i : 1
      offset = 1 if offset < 1
      limit = args["limit"] ? args["limit"].to_i : 200
      limit = 200 if limit <= 0
      entries = []
      last = [names.size - 1, offset + limit - 1].min
      id = offset
      while id <= last
        value = store[id]
        value = (value ? true : false) if kind == "switch"
        entries << { "id" => id, "name" => names[id].to_s, "value" => value }
        id += 1
      end
      { "total" => names.size - 1, "offset" => offset, "limit" => limit, "entries" => entries }
    end

    def flag_set(kind, args)
      names = system_names(kind)
      id = args["id"].to_i
      raise "#{kind} id #{id} exceeds system limit #{names.size - 1}" if id < 1 || id >= names.size
      store = flag_store(kind)
      if kind == "switch"
        store[id] = truthy(args["value"])
        { "id" => id, "value" => store[id] ? true : false }
      else
        store[id] = args["value"].to_i
        { "id" => id, "value" => store[id] }
      end
    end

    # --- self switches (VX / VX Ace only; XP has none) ----------------------------
    def self_switches
      ss = $game_self_switches
      raise "unsupported on RGSS: this engine has no self switches" unless ss
      ss
    end

    def self_switch_list(args)
      ss = self_switches
      map_id = args["mapId"].to_i
      entries = []
      ss.keys.each do |key|
        next unless key.is_a?(Array) && key[0] == map_id
        entries << {
          "mapId" => key[0],
          "eventId" => key[1],
          "letter" => key[2].to_s,
          "value" => ss[key] ? true : false
        }
      end
      { "mapId" => map_id, "entries" => entries }
    end

    def self_switch_set(args)
      ss = self_switches
      map_id = args["mapId"].to_i
      event_id = args["eventId"].to_i
      letter = args["letter"].to_s.upcase
      letter = "A" if letter.empty?
      key = [map_id, event_id, letter]
      ss[key] = truthy(args["value"])
      $game_map.need_refresh = true if $game_map && $game_map.respond_to?(:need_refresh=)
      { "mapId" => map_id, "eventId" => event_id, "letter" => letter, "value" => ss[key] ? true : false }
    end

    # --- map ----------------------------------------------------------------------
    # Engine accessors like Game_Map#display_name internally hit the map data
    # object, which is nil until a game actually starts -- so every field is
    # guarded individually, not just checked with respond_to?.
    def try_send(obj, method)
      return nil unless obj && obj.respond_to?(method)
      obj.send(method)
    rescue Exception
      nil
    end

    def map_info_payload
      return nil unless $game_map
      id = try_send($game_map, :map_id)
      infos = $data_mapinfos
      name = ""
      begin
        name = infos[id].name.to_s if infos && id && infos[id]
      rescue Exception
      end
      {
        "mapId" => id,
        "mapName" => name,
        "displayName" => try_send($game_map, :display_name).to_s,
        "x" => try_send($game_player, :x),
        "y" => try_send($game_player, :y),
        "direction" => try_send($game_player, :direction),
        "width" => try_send($game_map, :width),
        "height" => try_send($game_map, :height)
      }
    end

    def map_list
      infos = $data_mapinfos
      raise "$data_mapinfos is unavailable" unless infos
      entries = []
      infos.keys.sort.each do |id|
        info = infos[id]
        next unless info
        entries << {
          "id" => id,
          "name" => info.respond_to?(:name) ? info.name.to_s : "",
          "parentId" => info.respond_to?(:parent_id) ? info.parent_id : nil,
          "order" => info.respond_to?(:order) ? info.order : nil
        }
      end
      { "total" => entries.length, "entries" => entries }
    end

    def map_transfer(args)
      map_id = args["mapId"].to_i
      x = args["x"].to_i
      y = args["y"].to_i
      raise "mapId must be positive" if map_id <= 0
      raise "no player yet: start or continue a game first" unless $game_player
      if $game_player.respond_to?(:reserve_transfer)
        # VX Ace takes (map_id, x, y, direction); VX takes three args.
        if $game_player.method(:reserve_transfer).arity.abs >= 4
          $game_player.reserve_transfer(map_id, x, y, 0)
        else
          $game_player.reserve_transfer(map_id, x, y)
        end
      elsif $game_temp && $game_temp.respond_to?(:player_transferring=)
        # XP: Scene_Map picks these up on its next update.
        $game_temp.player_transferring = true
        $game_temp.player_new_map_id = map_id
        $game_temp.player_new_x = x
        $game_temp.player_new_y = y
        $game_temp.player_new_direction = 0 if $game_temp.respond_to?(:player_new_direction=)
      else
        raise "map transfer is unavailable"
      end
      { "mapId" => map_id, "x" => x, "y" => y }
    end

    # --- save slots -------------------------------------------------------------
    # Slot ids are 1-based, matching the GUI and the MV/MZ bridge. RGSS3 defers
    # to the game's own DataManager, so custom save systems (subdirectories,
    # extra contents, quick saves) keep working; XP/VX have no DataManager, so
    # the vanilla Scene_File write/read sequence is inlined instead. Games that
    # replaced the whole save system on XP/VX may not round-trip.

    def save_ext
      return "rvdata2" if rgss3?
      return "rxdata" if rgss1?
      "rvdata"
    end

    # Save file name relative to the game cwd for a 0-based index. The cwd is
    # the shadow copy; the real game directory mirrors it.
    def save_rel_name(index)
      if rgss3?
        if defined?(DataManager) && DataManager.respond_to?(:make_filename)
          return DataManager.make_filename(index)
        end
        return sprintf("Save%02d.rvdata2", index + 1)
      end
      "Save" + (index + 1).to_s + "." + save_ext
    end

    # The directory in the real game tree that actually holds the saves —
    # reported as saveDir so host-side backup/restore/delete work unchanged.
    def save_dir_real
      return nil if @real_dir.to_s.empty?
      rel = File.dirname(save_rel_name(0))
      return @real_dir if rel == "." || rel.empty?
      @real_dir + "/" + rel
    end

    # Read the source fully (binary mode — IO.read is text mode on Windows and
    # would corrupt Marshal data) before opening the destination: shadow files
    # are hard links to the real game files, so a streaming copy could
    # truncate its own source when both names resolve to the same file.
    def safe_copy(src, dst)
      data = File.open(src, "rb") { |f| f.read }
      dir = File.dirname(dst)
      Dir.mkdir(dir) unless FileTest.directory?(dir)
      File.open(dst, "wb") { |f| f.write(data) }
    end

    def save_list
      dir = save_dir_real
      entries = []
      if dir
        begin
          re = Regexp.new("\\." + save_ext + "$", true)
          Dir.foreach(dir) do |name|
            next unless name =~ re
            begin
              path = dir + "/" + name
              next unless FileTest.file?(path)
              entries << {
                "name" => name,
                "size" => File.size(path),
                "mtime" => File.mtime(path).getgm.strftime("%Y-%m-%dT%H:%M:%SZ")
              }
            rescue Exception
            end
          end
        rescue Exception
        end
      end
      entries = entries.sort_by { |e| e["name"].downcase }
      { "dir" => dir, "entries" => entries }
    end

    def save_save(id)
      raise "save id must be 1 or greater" if id < 1
      index = id - 1
      rel = save_rel_name(index)
      if rgss3?
        raise "DataManager is unavailable" unless defined?(DataManager)
        ok = DataManager.save_game(index)
        raise "save_game returned false" unless ok
      else
        File.open(rel, "wb") { |file| write_save_data(file) }
      end
      # Write through to the real game directory immediately; the GUI lists
      # and backs up that side, and the launcher sync would otherwise only run
      # on exit.
      safe_copy(rel, @real_dir + "/" + rel) unless @real_dir.to_s.empty?
      { "id" => id, "saved" => true }
    end

    def save_load(id)
      raise "save id must be 1 or greater" if id < 1
      index = id - 1
      rel = save_rel_name(index)
      real = @real_dir.to_s.empty? ? nil : @real_dir + "/" + rel
      if real && FileTest.file?(real)
        # The real directory is authoritative; refresh the shadow copy so the
        # engine reads the latest file even if it changed externally.
        safe_copy(real, rel)
      elsif !FileTest.file?(rel)
        raise "save file not found: " + File.basename(rel)
      end
      if rgss3?
        ok = DataManager.load_game(index)
        raise "load_game returned false" unless ok
        begin
          Patch.patch if defined?(::Patch) && ::Patch.respond_to?(:patch)
        rescue Exception
        end
        begin
          $game_system.on_after_load
        rescue Exception
        end
        SceneManager.goto(Scene_Map)
      else
        File.open(rel, "rb") { |file| read_save_data(file) }
        after_load_legacy
      end
      { "id" => id, "loaded" => true }
    end

    # Vanilla Scene_Save/Scene_File write sequence (XP 078_Scene_Save.rb,
    # VX 083_Scene_File.rb).
    def write_save_data(file)
      if rgss1?
        characters = []
        $game_party.actors.each do |actor|
          characters.push([actor.character_name, actor.character_hue])
        end
        $game_system.save_count += 1
        $game_system.magic_number = $data_system.magic_number
        Marshal.dump(characters, file)
        Marshal.dump(Graphics.frame_count, file)
        Marshal.dump($game_system, file)
        Marshal.dump($game_switches, file)
        Marshal.dump($game_variables, file)
        Marshal.dump($game_self_switches, file)
        Marshal.dump($game_screen, file)
        Marshal.dump($game_actors, file)
        Marshal.dump($game_party, file)
        Marshal.dump($game_troop, file)
        Marshal.dump($game_map, file)
        Marshal.dump($game_player, file)
      else
        characters = []
        $game_party.members.each do |actor|
          characters.push([actor.character_name, actor.character_index])
        end
        $game_system.save_count += 1
        $game_system.version_id = $data_system.version_id
        last_bgm = RPG::BGM::last
        last_bgs = RPG::BGS::last
        Marshal.dump(characters, file)
        Marshal.dump(Graphics.frame_count, file)
        Marshal.dump(last_bgm, file)
        Marshal.dump(last_bgs, file)
        Marshal.dump($game_system, file)
        Marshal.dump($game_message, file)
        Marshal.dump($game_switches, file)
        Marshal.dump($game_variables, file)
        Marshal.dump($game_self_switches, file)
        Marshal.dump($game_actors, file)
        Marshal.dump($game_party, file)
        Marshal.dump($game_troop, file)
        Marshal.dump($game_map, file)
        Marshal.dump($game_player, file)
      end
    end

    # Vanilla read sequence (XP 079_Scene_Load.rb, VX 083_Scene_File.rb).
    def read_save_data(file)
      if rgss1?
        Marshal.load(file) # characters
        Graphics.frame_count = Marshal.load(file)
        $game_system = Marshal.load(file)
        $game_switches = Marshal.load(file)
        $game_variables = Marshal.load(file)
        $game_self_switches = Marshal.load(file)
        $game_screen = Marshal.load(file)
        $game_actors = Marshal.load(file)
        $game_party = Marshal.load(file)
        $game_troop = Marshal.load(file)
        $game_map = Marshal.load(file)
        $game_player = Marshal.load(file)
        if $game_system.magic_number != $data_system.magic_number
          $game_map.setup($game_map.map_id)
          $game_player.center($game_player.x, $game_player.y)
        end
        $game_party.refresh
      else
        Marshal.load(file) # characters
        Graphics.frame_count = Marshal.load(file)
        @last_bgm = Marshal.load(file)
        @last_bgs = Marshal.load(file)
        $game_system = Marshal.load(file)
        $game_message = Marshal.load(file)
        $game_switches = Marshal.load(file)
        $game_variables = Marshal.load(file)
        $game_self_switches = Marshal.load(file)
        $game_actors = Marshal.load(file)
        $game_party = Marshal.load(file)
        $game_troop = Marshal.load(file)
        $game_map = Marshal.load(file)
        $game_player = Marshal.load(file)
        if $game_system.version_id != $data_system.version_id
          $game_map.setup($game_map.map_id)
          $game_player.center($game_player.x, $game_player.y)
        end
      end
    end

    # What the engine does after a successful load: restore audio, let the map
    # run one update for parallel events, then switch to the map scene. The
    # post-steps are guarded because the load itself already succeeded.
    def after_load_legacy
      if rgss1?
        # Vanilla Scene_Load#initialize recreates $game_temp before the scene
        # even opens; scripts that alias Scene_Map#update (tips, quest trackers)
        # call $game_temp on the very first frame, so skipping this kills the
        # game one frame after the load (实测: 武界风云传 XdRs_PCTips).
        begin
          $game_temp = Game_Temp.new
        rescue Exception
        end
        begin
          $game_system.bgm_play($game_system.playing_bgm)
          $game_system.bgs_play($game_system.playing_bgs)
        rescue Exception
        end
        begin
          $game_map.update
        rescue Exception
        end
      else
        begin
          @last_bgm.play if @last_bgm
          @last_bgs.play if @last_bgs
        rescue Exception
        end
      end
      $scene = Scene_Map.new
    end

    # --- save contents tree (数据修改) ------------------------------------------
    # MV/MZ JsonEx-serializes the live save contents into a JSON tree the GUI
    # edits, then parses it back in-page. RGSS mirrors the read side with a
    # tagged-JSON dumper; the write side does NOT parse JSON in Ruby (1.8.1 has
    # no JSON library and a pure-Ruby parser would crawl on multi-MB trees) —
    # core/rgss-savecode.mjs compiles the edited tree into Ruby source and the
    # bridge just evals it, letting Ruby's own parser do the work.

    JDUMP_DEPTH_LIMIT = 500

    def save_contents_get(args)
      party! # contents only exist once a game is running (XP title screen guard)
      if rgss3? && defined?(DataManager) && DataManager.respond_to?(:make_save_contents)
        contents = DataManager.make_save_contents
      else
        contents = legacy_contents
      end
      # First pass: count references per object so the emit pass can tell
      # shared nodes (DAG aliasing or outright cycles — leg-x's custom
      # Game_BattleAction holds @battler while the actor holds @action back)
      # apart from ordinary ones. Only shared nodes carry @id/@ref wrappers.
      @jd_counts = {}
      contents.each_value { |v| jd_count(v, @jd_counts) }
      @jd_ids = {}
      @jd_seq = 0
      @jd_path = []
      json = "{"
      first = true
      contents.each do |key, value|
        json << "," unless first
        first = false
        jd_str(key.to_s, json)
        json << ":"
        jd_value(value, 0, json)
      end
      json << "}"
      limit = args["limitBytes"].to_i
      limit = 12 * 1024 * 1024 if limit <= 0
      if json.length > limit
        raise "save contents is " + json.length.to_s + " bytes, over the " + limit.to_s +
          " byte limit — raise limitBytes if you really want to load it into the editor"
      end
      keys = []
      contents.each_key { |k| keys << k.to_s }
      { "json" => json, "bytes" => json.length, "keys" => keys }
    end

    # XP/VX have no DataManager; the key list mirrors the vanilla Scene_Save /
    # Scene_File write order above (screen is XP-only, message is VX-only).
    def legacy_contents
      c = {}
      c["system"] = $game_system
      c["message"] = $game_message if rgss2?
      c["switches"] = $game_switches
      c["variables"] = $game_variables
      c["selfSwitches"] = $game_self_switches
      c["screen"] = $game_screen if rgss1?
      c["actors"] = $game_actors
      c["party"] = $game_party
      c["troop"] = $game_troop
      c["map"] = $game_map
      c["player"] = $game_player
      c
    end

    def save_contents_apply(line)
      code = extract_string_field(line, "code")
      raise "code is empty" if code.nil? || code.strip.empty?
      reload = extract_bool_field(line, "reload")
      reload = true if reload.nil?
      contents = eval(code)
      raise "contents is not a Hash" unless contents.is_a?(Hash)
      skipped = []
      if rgss3? && defined?(DataManager) && DataManager.respond_to?(:extract_save_contents)
        # extract_save_contents reads symbol keys; customs (hs adds :stats) keep
        # working because every key is converted, known or not.
        sym = {}
        contents.each { |k, v| sym[k.to_s.to_sym] = v }
        DataManager.extract_save_contents(sym)
        begin
          Patch.patch if defined?(::Patch) && ::Patch.respond_to?(:patch)
        rescue Exception
        end
        begin
          $game_system.on_after_load
        rescue Exception
        end
        SceneManager.goto(Scene_Map) if reload
      else
        skipped = assign_contents_legacy(contents)
        after_load_legacy if reload
      end
      { "applied" => true, "reloaded" => reload, "bytes" => code.length, "skipped" => skipped }
    end

    # Assign each known contents key to its global. Keys the vanilla contents
    # do not define (a custom save system's extras on XP/VX) are reported back
    # instead of being silently dropped.
    def assign_contents_legacy(c)
      $game_system = c["system"] if c.has_key?("system")
      $game_message = c["message"] if c.has_key?("message")
      $game_switches = c["switches"] if c.has_key?("switches")
      $game_variables = c["variables"] if c.has_key?("variables")
      $game_self_switches = c["selfSwitches"] if c.has_key?("selfSwitches")
      $game_screen = c["screen"] if c.has_key?("screen")
      $game_actors = c["actors"] if c.has_key?("actors")
      $game_party = c["party"] if c.has_key?("party")
      $game_troop = c["troop"] if c.has_key?("troop")
      $game_map = c["map"] if c.has_key?("map")
      $game_player = c["player"] if c.has_key?("player")
      known = ["system", "message", "switches", "variables", "selfSwitches",
               "screen", "actors", "party", "troop", "map", "player"]
      skipped = []
      c.each_key { |k| skipped << k.to_s unless known.include?(k.to_s) }
      skipped
    end

    # Tagged-JSON serializer for the contents tree. Plain JSON carries
    # null/bool/number/string/array directly; everything else gets a tag object
    # so rgss-savecode.mjs can rebuild the exact Ruby types (JSON objects
    # cannot express Hash-with-integer-keys, Symbols, Tables...). Nodes that
    # the counting pass marked as shared (DAG aliasing like Game_Event#@event,
    # or outright cycles like a custom Game_BattleAction#@battler) carry an
    # "@id" on first occurrence and emit as {"@ref":N} afterwards, preserving
    # object identity across apply; the depth cap guards deep nesting.
    def jd_value(obj, depth, out)
      if depth > JDUMP_DEPTH_LIMIT
        path = (@jd_path || []).last(16).join("/")
        raise "save contents tree is deeper than " + JDUMP_DEPTH_LIMIT.to_s +
          " — possible cycle at " + path
      end
      case obj
      when nil
        out << "null"
      when true
        out << "true"
      when false
        out << "false"
      when Integer
        if obj.abs > 9007199254740991
          out << '{"@i":"' << obj.to_s << '"}'
        else
          out << obj.to_s
        end
      when Float
        if obj.nan?
          out << '{"@f":"NaN"}'
        elsif obj.infinite?
          out << (obj.infinite? > 0 ? '{"@f":"Infinity"}' : '{"@f":"-Infinity"}')
        else
          out << obj.to_s
        end
      when String
        if jd_utf8?(obj)
          jd_str(obj, out)
        else
          out << '{"@b64":"' << [obj].pack("m").delete("\n") << '"}'
        end
      when Symbol
        out << '{"@sym":'
        jd_str(obj.to_s, out)
        out << "}"
      when Array
        oid = obj.object_id
        if jd_shared?(oid)
          id = @jd_ids[oid]
          if id
            out << '{"@ref":' << id.to_s << "}"
            return
          end
          @jd_seq += 1
          @jd_ids[oid] = @jd_seq
          out << '{"@id":' << @jd_seq.to_s << ',"@arr":['
          jd_array_items(obj, depth, out)
          out << "]}"
        else
          out << "["
          jd_array_items(obj, depth, out)
          out << "]"
        end
      when Hash
        oid = obj.object_id
        if jd_shared?(oid)
          id = @jd_ids[oid]
          if id
            out << '{"@ref":' << id.to_s << "}"
            return
          end
          @jd_seq += 1
          @jd_ids[oid] = @jd_seq
          out << '{"@id":' << @jd_seq.to_s << ',"@hash":['
          jd_hash_pairs(obj, depth, out)
          out << "]}"
        else
          out << '{"@hash":['
          jd_hash_pairs(obj, depth, out)
          out << "]}"
        end
      when Table
        jd_table(obj, out)
      when Color
        out << '{"@color":[' << obj.red.to_s << "," << obj.green.to_s << "," <<
          obj.blue.to_s << "," << obj.alpha.to_s << "]}"
      when Tone
        out << '{"@tone":[' << obj.red.to_s << "," << obj.green.to_s << "," <<
          obj.blue.to_s << "," << obj.gray.to_s << "]}"
      when Rect
        out << '{"@rect":[' << obj.x.to_s << "," << obj.y.to_s << "," <<
          obj.width.to_s << "," << obj.height.to_s << "]}"
      else
        if obj.is_a?(::Module)
          # Class/module objects are serialized as constant references —
          # Game_BaseItem#@class holds RPG::Weapon itself, and
          # "::Class.allocate" would create an anonymous class that Marshal
          # (i.e. the game's own save) cannot dump.
          name = jd_module_name(obj)
          if name.empty? || name =~ /^#</
            out << '{"@dead":"anonymous-module"}'
          else
            out << '{"@cref":'
            jd_str(name, out)
            out << "}"
          end
          return
        end
        if jd_dead?(obj)
          out << '{"@dead":'
          jd_str(jd_class_name(obj), out)
          out << "}"
          return
        end
        oid = obj.object_id
        if jd_shared?(oid)
          id = @jd_ids[oid]
          if id
            out << '{"@ref":' << id.to_s << "}"
            return
          end
          @jd_seq += 1
          @jd_ids[oid] = @jd_seq
          out << '{"@id":' << @jd_seq.to_s << ',"@cls":'
        else
          out << '{"@cls":'
        end
        jd_str(jd_class_name(obj), out)
        out << ',"@iv":{'
        jd_ivars(obj, depth, out)
        out << "}}"
      end
    end

    # Custom scripts can override #class with an accessor of their own (VX
    # battlers expose their RPG::Class that way); bind the original method to
    # get the real class name.
    def jd_class_name(obj)
      Object.instance_method(:class).bind(obj).call.to_s
    rescue Exception
      obj.class.to_s
    end

    # A class/module's own name, immune to to_s overrides.
    def jd_module_name(obj)
      Module.instance_method(:name).bind(obj).call.to_s
    rescue Exception
      obj.to_s
    end

    # Objects Marshal itself could not dump (a live Fiber mid-event, Procs,
    # threads, handles) cannot be reconstructed. They come back as nil on
    # apply — matching what a save written after the event finished holds.
    def jd_dead?(obj)
      (defined?(::Fiber) && obj.is_a?(::Fiber)) ||
        (defined?(::Continuation) && obj.is_a?(::Continuation)) ||
        obj.is_a?(::Proc) || obj.is_a?(::Thread) ||
        obj.is_a?(::Method) || obj.is_a?(::UnboundMethod) || obj.is_a?(::IO)
    end

    # First pass over the contents graph: count how many times each compound
    # node is referenced. A revisit stops the descent — that is what makes
    # cycles terminate. Leaf C classes (Table/Color/Tone/Rect) and value types
    # never need identity tracking.
    def jd_count(obj, counts)
      case obj
      when Array
        oid = obj.object_id
        n = counts[oid] || 0
        counts[oid] = n + 1
        return if n > 0
        obj.each { |v| jd_count(v, counts) }
      when Hash
        oid = obj.object_id
        n = counts[oid] || 0
        counts[oid] = n + 1
        return if n > 0
        obj.each do |k, v|
          jd_count(k, counts)
          jd_count(v, counts)
        end
      when Table, Color, Tone, Rect, String, Symbol, Integer, Float, true, false, nil
        nil
      else
        return if jd_dead?(obj)
        return if obj.is_a?(::Module)
        oid = obj.object_id
        n = counts[oid] || 0
        counts[oid] = n + 1
        return if n > 0
        obj.instance_variables.each { |iv| jd_count(obj.instance_variable_get(iv), counts) }
      end
    end

    def jd_shared?(oid)
      (@jd_counts[oid] || 0) > 1
    end

    def jd_array_items(obj, depth, out)
      first = true
      idx = 0
      obj.each do |item|
        out << "," unless first
        first = false
        @jd_path.push("[" + idx.to_s + "]")
        jd_value(item, depth + 1, out)
        @jd_path.pop
        idx += 1
      end
    end

    def jd_hash_pairs(obj, depth, out)
      first = true
      obj.each do |k, v|
        out << "," unless first
        first = false
        out << "["
        jd_value(k, depth + 1, out)
        out << ","
        @jd_path.push("{" + k.class.to_s + "}")
        jd_value(v, depth + 1, out)
        @jd_path.pop
        out << "]"
      end
    end

    def jd_ivars(obj, depth, out)
      first = true
      obj.instance_variables.each do |name|
        out << "," unless first
        first = false
        jd_str(name.to_s, out)
        out << ":"
        @jd_path.push(obj.class.to_s + name.to_s)
        jd_value(obj.instance_variable_get(name), depth + 1, out)
        @jd_path.pop
      end
    end

    # JSON is UTF-8 on the wire; strings whose bytes are not valid UTF-8 would
    # corrupt the Node side's decode, so they take the base64 tag instead.
    def jd_utf8?(str)
      if str.respond_to?(:valid_encoding?)
        enc = str.encoding.to_s
        return str.valid_encoding? if enc == "UTF-8"
        return true if enc == "US-ASCII"
        return false
      end
      return true unless str =~ /[\x80-\xff]/n
      begin
        str.unpack("U*")
        true
      rescue Exception
        false
      end
    end

    # Unlike jstr (which passes high bytes through for the transport frames),
    # strings inside the contents tree are emitted as pure ASCII with \uXXXX
    # escapes — the payload is built before the final encoding question (1.8.1
    # bytes vs 1.9.2 string encodings) can corrupt it, and Node decodes the
    # escapes back to the exact same UTF-8 bytes.
    def jd_str(str, out)
      out << '"'
      str.unpack("U*").each do |cp|
        if cp == 34
          out << '\\"'
        elsif cp == 92
          out << '\\\\'
        elsif cp == 10
          out << '\\n'
        elsif cp == 13
          out << '\\r'
        elsif cp == 9
          out << '\\t'
        elsif cp < 32 || cp == 127
          out << sprintf('\\u%04x', cp)
        elsif cp < 128
          out << cp.chr
        elsif cp < 0x10000
          out << sprintf('\\u%04x', cp)
        else
          cp -= 0x10000
          out << sprintf('\\u%04x\\u%04x', 0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF))
        end
      end
      out << '"'
      out
    end

    def jd_table(obj, out)
      xs = obj.xsize
      ys = obj.ysize
      zs = obj.zsize
      # The accessor arity is fixed at Table.new and not exposed afterwards —
      # passages-style 1D tables reject [x, y, z]. Probe it once.
      dims = 1
      begin
        obj[0, 0, 0]
        dims = 3
      rescue ArgumentError
        begin
          obj[0, 0]
          dims = 2
        rescue ArgumentError
          dims = 1
        end
      end
      out << '{"@table":{"x":' << xs.to_s << ',"y":' << ys.to_s << ',"z":' << zs.to_s <<
        ',"d":' << dims.to_s << ',"data":['
      first = true
      z = 0
      while z < (dims >= 3 ? zs : 1)
        y = 0
        while y < (dims >= 2 ? ys : 1)
          x = 0
          while x < xs
            out << "," unless first
            first = false
            if dims == 3
              out << obj[x, y, z].to_s
            elsif dims == 2
              out << obj[x, y].to_s
            else
              out << obj[x].to_s
            end
            x += 1
          end
          y += 1
        end
        z += 1
      end
      out << "]}}"
    end

    # --- state push -------------------------------------------------------------
    # VX Ace tracks battle state on the party, XP/VX on $game_temp.
    def in_battle?
      if $game_party && $game_party.respond_to?(:in_battle) && $game_party.in_battle
        return true
      end
      return false unless $game_temp
      if $game_temp.respond_to?(:in_battle)
        return $game_temp.in_battle ? true : false
      end
      if $game_temp.respond_to?(:battle_calling)
        return $game_temp.battle_calling ? true : false
      end
      false
    rescue Exception
      false
    end

    # Same wire shape as the MV/MZ bridge's collectState(), minus what RGSS
    # cannot know (hooks, profile).
    def state_payload
      party = $game_party
      gold = party && party.respond_to?(:gold) ? party.gold.to_i : nil
      {
        "bridgeVersion" => VERSION,
        "gameKey" => @game_key,
        "engine" => { "maker" => engine_label },
        "gold" => gold,
        "map" => map_info_payload,
        "party" => party_state,
        "saveDir" => save_dir_real,
        "inBattle" => in_battle?,
        "options" => options
      }
    end

    def push_state
      send_frame("state", { "state" => state_payload })
    end

    # --- trainer options --------------------------------------------------------
    # Same key set and ranges as the MV/MZ bridge (runtime/bridge/src/parts/
    # 40-hooks.js), so the GUI's 修改器 panel drives both engines unchanged.
    BOOL_OPTIONS = ["invincible", "oneHitKill", "noSkillCost", "throughWalls",
      "noEncounter", "showFollowers", "alwaysDash", "speedHoldCtrl",
      "lockHp", "lockHpMax", "lockMp", "lockTp"]
    RATE_OPTIONS = ["expRate", "goldRate", "dropRate"]
    NUM_OPTIONS = ["lockHpVal", "lockMpVal", "lockTpVal", "moveSpeedAdd", "gameSpeedMulti"]

    def options
      @options ||= default_options
    end

    def default_options
      o = {}
      BOOL_OPTIONS.each { |k| o[k] = false }
      RATE_OPTIONS.each { |k| o[k] = 1.0 }
      NUM_OPTIONS.each { |k| o[k] = 0.0 }
      o["gameSpeedMulti"] = 1.0
      o
    end

    def clamp_float(raw, min, max, fallback)
      value = Float(raw)
      value = fallback if value.nan? || value.infinite?
      value = min if value < min
      value = max if value > max
      value
    rescue Exception
      fallback
    end

    def set_options(patch)
      opts = options
      RATE_OPTIONS.each do |k|
        next unless patch.key?(k)
        opts[k] = clamp_float(patch[k], 0.0, 999.0, opts[k])
      end
      NUM_OPTIONS.each do |k|
        next unless patch.key?(k)
        min = (k == "gameSpeedMulti") ? 1.0 : -9999.0
        opts[k] = clamp_float(patch[k], min, 9999.0, opts[k])
      end
      BOOL_OPTIONS.each do |k|
        next unless patch.key?(k)
        opts[k] = truthy(patch[k])
      end
      opts
    end

    # --- engine hooks -----------------------------------------------------------
    # Method wrapping mirrors the MV/MZ patchMethod: the original is aliased
    # once per class, installation is idempotent, and every wrapper funnels
    # through RMCH so option checks stay in one place.

    def hook_targets
      @hook_targets ||= []
    end

    # Wrap klass_name#method_name once; the wrapper calls
    # RMCH.run_hook(tag, receiver, original_method, args_array). Inherited
    # methods are fine: alias_method copies them into the class. The alias name
    # carries the class + method name, so several methods can share one tag and
    # a subclass's super never re-enters its own alias. Returns
    # false when the class or method does not exist (generation differences).
    def wrap_method(klass_name, method_name, tag)
      klass = Object.const_get(klass_name)
      names = klass.instance_methods.map { |m| m.to_s }
      return false unless names.include?(method_name.to_s)
      # The marker must be unique per class: `method(marker)` on the receiver
      # resolves the most-derived alias, so a shared name makes a subclass
      # override that calls super bounce back into its own alias — infinite
      # recursion (实测: 武界风云传 Game_Actor#skill_can_use? → super →
      # Game_Battler wrapper → Game_Actor alias → SystemStackError).
      marker = "rmch_orig_#{klass_name}_#{method_name}"
      own = klass.instance_methods(false).map { |m| m.to_s }
      return true if own.include?(marker)
      body = lambda do |*args|
        RMCH.run_hook(tag, self, method(marker), args)
      end
      klass.class_eval do
        alias_method marker, method_name
        define_method(method_name, body)
      end
      hook_targets << "#{klass_name}.#{method_name}"
      true
    rescue Exception
      false
    end

    # One dispatcher for every wrapper: keeps the generated methods tiny and
    # all policy in RMCH.
    def run_hook(tag, receiver, original, args)
      case tag
      when "hp" then hook_hp_write(receiver, original, args)
      when "mp" then hook_mp_write(receiver, original, args)
      when "tp" then hook_tp_write(receiver, original, args)
      when "action" then hook_action(receiver, original, args)
      when "skillcost" then hook_skill_cost(receiver, original, args)
      when "skilluse" then hook_skill_use(receiver, original, args)
      when "exp" then scale_reward(original.call(*args), "expRate")
      when "gold" then scale_reward(original.call(*args), "goldRate")
      when "drop" then original.call(*args) * options["dropRate"]
      when "makedrops" then run_make_drops(receiver, original, args)
      when "dash" then options["alwaysDash"] ? true : original.call(*args)
      else original.call(*args)
      end
    end

    def install_hooks
      return if @hooks_done
      @hooks_done = true
      install_vital_hooks
      install_action_hooks
      install_skill_cost_hooks
      install_reward_hooks
      # XP has no dash system; wrap_method simply misses there.
      wrap_method("Game_Player", "dash?", "dash")
      hook_targets
    end

    # --- vitals (无敌 / 锁血·锁蓝·锁TP) ------------------------------------------
    # All three generations funnel HP damage through a setter: XP/VX
    # Game_Battler#hp=, VX Ace Game_BattlerBase#hp=. MP is sp= on XP, mp=
    # elsewhere; TP exists only on Ace.
    def battler_owner_class
      rgss3? ? "Game_BattlerBase" : "Game_Battler"
    end

    def install_vital_hooks
      owner = battler_owner_class
      wrap_method(owner, "hp=", "hp")
      wrap_method(owner, "mp=", "mp")
      wrap_method(owner, "sp=", "mp")
      wrap_method(owner, "tp=", "tp")
    end

    def actor_battler?(battler)
      battler.is_a?(Game_Actor)
    rescue Exception
      false
    end

    def battler_hp(battler)
      battler.hp.to_i
    rescue Exception
      0
    end

    def battler_mp(battler)
      (battler.respond_to?(:mp) ? battler.mp : battler.sp).to_i
    rescue Exception
      0
    end

    def locked_hp_target(battler)
      if options["lockHpMax"]
        max = first_int(battler, [:mhp, :maxhp])
        return max if max > 0
      end
      value = options["lockHpVal"].to_i
      value > 0 ? value : nil
    end

    # Lowest HP value a write may request, or nil when unguarded. Invincibility
    # is battle-only on purpose (same as MV/MZ): out of battle HP loss is
    # usually a scripted story beat and blocking it wedges events.
    def hp_floor_for(battler)
      return nil unless actor_battler?(battler)
      floor = nil
      if options["invincible"] && in_battle?
        floor = battler_hp(battler)
      end
      if options["lockHp"]
        locked = locked_hp_target(battler)
        floor = locked if locked && (floor.nil? || locked > floor)
      end
      floor
    end

    def hook_hp_write(battler, original, args)
      value = args[0].to_i
      unless suppressed?
        floor = hp_floor_for(battler)
        value = floor if floor && value < floor
      end
      original.call(value)
    end

    def hook_mp_write(battler, original, args)
      value = args[0].to_i
      unless suppressed?
        # XP pays skill costs inline (battler.sp -= skill.sp_cost), so
        # noSkillCost has to refuse the write itself; VX/Ace hook the cost
        # calculation instead. SP decreases are ~always skill costs.
        if rgss1? && options["noSkillCost"] && actor_battler?(battler)
          current = battler_mp(battler)
          value = current if value < current
        end
        if options["lockMp"] && actor_battler?(battler)
          locked = options["lockMpVal"].to_i
          value = locked if locked > 0 && value < locked
        end
      end
      original.call(value)
    end

    def hook_tp_write(battler, original, args)
      value = args[0].to_i
      if !suppressed? && options["lockTp"] && actor_battler?(battler)
        locked = options["lockTpVal"].to_i
        value = locked if locked > 0 && value < locked
      end
      original.call(value)
    end

    # Per-frame re-assert, for scripts that write @hp directly instead of going
    # through the setter (same reason the MV/MZ bridge runs a guard tick).
    def apply_vitals_locks
      return if suppressed?
      return unless options["lockHp"] || options["lockMp"] || options["lockTp"]
      party = $game_party
      return unless party
      party_members(party).each do |actor|
        if options["lockHp"]
          target = locked_hp_target(actor)
          if target && battler_hp(actor) != target
            with_suppression { actor.hp = target }
          end
        end
        if options["lockMp"]
          locked = options["lockMpVal"].to_i
          if locked > 0 && battler_mp(actor) != locked
            setter = actor.respond_to?(:mp=) ? :mp= : :sp=
            with_suppression { actor.send(setter, locked) }
          end
        end
        if options["lockTp"] && actor.respond_to?(:tp) && actor.respond_to?(:tp=)
          locked = options["lockTpVal"].to_i
          if locked > 0 && actor.tp.to_i != locked
            with_suppression { actor.tp = locked }
          end
        end
      end
    rescue Exception
    end

    # --- battle actions (无敌快照 / 一击必杀) ------------------------------------
    # XP/VX resolve attacks in Game_Battler#attack_effect/#skill_effect, VX Ace
    # in Game_Battler#item_apply (Game_Action#apply is an MV invention).
    def install_action_hooks
      if rgss3?
        wrap_method("Game_Battler", "item_apply", "action")
      else
        wrap_method("Game_Battler", "attack_effect", "action")
        wrap_method("Game_Battler", "skill_effect", "action")
      end
    end

    def battler_alive?(battler)
      if battler.respond_to?(:exist?)
        battler.exist? ? true : false
      elsif battler.respond_to?(:alive?)
        battler.alive? ? true : false
      else
        battler_hp(battler) > 0
      end
    rescue Exception
      false
    end

    def kill_battler(battler)
      # hp=0 is the universal kill: XP's hp= manages the zero-HP states, VX's
      # dead? reads hp==0, and Ace's hp= runs refresh, which adds the death
      # state. (Ace's die() alone would clear states and report alive.)
      with_suppression { battler.hp = 0 }
    rescue Exception
    end

    # Shared wrapper for all three action entry points. The HP snapshot catches
    # custom scripts that bypass the hp= setter; oneHitKill runs after the
    # action so the engine's own hit/miss bookkeeping still happens.
    def hook_action(target, original, args)
      subject = args[0]
      snapshot = nil
      if (options["invincible"] || options["lockHp"]) && actor_battler?(target)
        snapshot = battler_hp(target)
      end
      result = original.call(*args)
      if snapshot
        floor = hp_floor_for(target)
        floor = snapshot if floor.nil? || snapshot > floor
        if battler_hp(target) < floor
          with_suppression { target.hp = floor }
        end
      end
      if options["oneHitKill"] && in_battle? &&
          actor_battler?(subject) && !actor_battler?(target) && battler_alive?(target)
        kill_battler(target)
      end
      result
    end

    # --- skill cost (免技能消耗) --------------------------------------------------
    # Ace checks and pays through skill_mp_cost/skill_tp_cost, VX through
    # calc_mp_cost, so zeroing the calculation covers both sites. XP inlines
    # sp_cost: the usability check is hooked here, the payment is refused by
    # the sp= wrapper above.
    def install_skill_cost_hooks
      if rgss3?
        wrap_method("Game_BattlerBase", "skill_mp_cost", "skillcost")
        wrap_method("Game_BattlerBase", "skill_tp_cost", "skillcost")
      elsif rgss1?
        # XP's Game_Actor overrides skill_can_use?, shadowing the base hook.
        wrap_method("Game_Battler", "skill_can_use?", "skilluse")
        wrap_method("Game_Actor", "skill_can_use?", "skilluse")
      else
        wrap_method("Game_Battler", "calc_mp_cost", "skillcost")
      end
    end

    def hook_skill_cost(battler, original, args)
      if options["noSkillCost"] && actor_battler?(battler)
        return 0
      end
      original.call(*args)
    end

    def hook_skill_use(battler, original, args)
      if options["noSkillCost"] && actor_battler?(battler)
        return true
      end
      original.call(*args)
    end

    # --- battle rewards (经验/金币/掉落倍率) --------------------------------------
    # VX/Ace sum rewards through Game_Troop#exp_total/#gold_total, called only
    # from victory processing, so scaling the return value cannot multiply
    # quest rewards the way a gain_exp hook would. XP totals inline in
    # Scene_Battle#start_phase5 from Game_Enemy readers; those readers are only
    # consulted there. Drop rate: Ace scales Game_Enemy#drop_item_rate, XP the
    # treasure probability; VX has no per-roll hook, so make_drop_items gets
    # re-rolled (multiplier > 1) or thinned (< 1).
    def install_reward_hooks
      if rgss1?
        wrap_method("Game_Enemy", "exp", "exp")
        wrap_method("Game_Enemy", "gold", "gold")
        wrap_method("Game_Enemy", "treasure_prob", "drop")
      else
        wrap_method("Game_Troop", "exp_total", "exp")
        wrap_method("Game_Troop", "gold_total", "gold")
        wrap_method("Game_Enemy", "drop_item_rate", "drop") if rgss3?
        wrap_method("Game_Troop", "make_drop_items", "makedrops") unless rgss3?
      end
    end

    def scale_reward(value, key)
      rate = options[key].to_f
      return value if rate == 1.0
      [(value.to_f * rate).to_i, 0].max
    end

    # VX drop multiplier: reroll for the integer part, probability-gate for the
    # fraction, thin out when below 1. Items dedup by identity.
    def run_make_drops(troop, original, args)
      rate = options["dropRate"].to_f
      base = original.call(*args)
      return base if rate == 1.0
      drops = base.is_a?(Array) ? base.dup : []
      if rate < 1.0
        kept = []
        drops.each { |item| kept << item if rand < rate }
        return kept
      end
      extra = rate.floor - 1
      extra += 1 if rand < (rate - rate.floor)
      extra.times do
        more = original.call(*args)
        more.each { |item| drops << item } if more.is_a?(Array)
      end
      drops
    end

    # --- world options (穿墙 / 不遇敌 / 移速 / 加速) -------------------------------
    # These map to plain engine fields rather than method hooks. The pump
    # re-asserts them every frame while ON (the game flips @through and
    # encounter_disabled itself via move routes and event commands); turning
    # one OFF restores the value from before we forced it.
    def apply_world_options
      if $game_player
        if options["throughWalls"]
          $game_player.instance_variable_set(:@through, true)
          @through_forced = true
        elsif @through_forced
          $game_player.instance_variable_set(:@through, false)
          @through_forced = false
        end
        apply_move_speed
      end
      if $game_system && $game_system.respond_to?(:encounter_disabled=)
        if options["noEncounter"]
          $game_system.encounter_disabled = true unless $game_system.encounter_disabled
          @encounter_forced = true
        elsif @encounter_forced
          $game_system.encounter_disabled = false
          @encounter_forced = false
        end
      end
    rescue Exception
    end

    # move_speed has no public writer on any generation, so write the ivar.
    # The base is tracked so an event that changes speed mid-game is adopted
    # instead of fought.
    def apply_move_speed
      add = options["moveSpeedAdd"].to_i
      current = $game_player.instance_variable_get(:@move_speed).to_i
      if add != 0
        base = current
        if @speed_written && current == @speed_written_value
          base = @speed_written_base
        end
        want = base + add
        want = 1 if want < 1
        want = 6 if want > 6
        if current != want
          $game_player.instance_variable_set(:@move_speed, want)
          @speed_written = true
          @speed_written_value = want
          @speed_written_base = base
        end
      elsif @speed_written
        if current == @speed_written_value
          $game_player.instance_variable_set(:@move_speed, @speed_written_base)
        end
        @speed_written = false
      end
    rescue Exception
    end

    # RGSS fast-forward: scale Graphics.frame_rate while Ctrl is held. The MV/MZ
    # bridge re-runs the update loop instead; RGSS scenes don't expose a clean
    # re-entry point, and frame_rate is the engine's own speed knob.
    def apply_game_speed
      holding = false
      if options["speedHoldCtrl"] && defined?(Input::CTRL)
        begin
          holding = Input.press?(Input::CTRL) ? true : false
        rescue Exception
          holding = false
        end
      end
      if holding
        multi = options["gameSpeedMulti"].to_f
        multi = 1.0 if multi < 1.0
        multi = 20.0 if multi > 20.0
        unless @speed_applied
          @base_frame_rate = Graphics.frame_rate
          @speed_applied = true
        end
        want = (@base_frame_rate * multi).to_i
        Graphics.frame_rate = want if Graphics.frame_rate != want
      elsif @speed_applied
        Graphics.frame_rate = @base_frame_rate
        @speed_applied = false
      end
    rescue Exception
    end

    # --- value locks (数据锁定) ---------------------------------------------------
    # Same wire shape and semantics as 50-value-locks.js: a live set re-asserted
    # every frame, written to the backing store (bag hash / @data array) rather
    # than through gain_item-style methods, so nothing re-enters the hooks.
    def value_locks
      @value_locks ||= {
        "gold" => nil,
        "item" => {}, "weapon" => {}, "armor" => {},
        "switch" => {}, "variable" => {}
      }
    end

    def snapshot_value_locks
      locks = value_locks
      out = { "gold" => locks["gold"] }
      LOCK_KINDS.each do |kind|
        copy = {}
        locks[kind].each_pair { |id, v| copy[id.to_s] = v }
        out[kind] = copy
      end
      out
    end

    def coerce_lock_value(kind, value)
      if kind == "switch"
        truthy(value)
      elsif kind == "variable"
        value.to_i
      else
        v = value.to_i
        v < 0 ? 0 : v
      end
    end

    def apply_value_locks
      locks = value_locks
      return if suppressed?
      party = $game_party
      if locks["gold"] && party
        party.instance_variable_set(:@gold, locks["gold"])
      end
      ITEM_BAG_IVARS.each_pair do |kind, ivar|
        table = locks[kind]
        next if table.empty? || party.nil?
        bag = party.instance_variable_get(ivar)
        next unless bag.is_a?(Hash)
        table.each_pair do |id, want|
          bag[id] = want if bag[id].to_i != want
        end
      end
      write_flag_locks(locks["switch"], $game_switches)
      write_flag_locks(locks["variable"], $game_variables)
      @lock_apply_count += 1
    rescue Exception
    end

    def write_flag_locks(table, store)
      return if table.empty? || store.nil?
      data = store.instance_variable_get(:@data)
      return unless data.is_a?(Array)
      table.each_pair do |id, want|
        data[id] = want if data[id] != want
      end
    end

    def lock_set(args)
      kind = args["kind"].to_s
      locks = value_locks
      enabled = args["enabled"].nil? ? true : truthy(args["enabled"])
      if kind == "gold"
        locks["gold"] = enabled ? [args["value"].to_i, 0].max : nil
        return { "kind" => kind, "enabled" => !locks["gold"].nil?, "value" => locks["gold"] }
      end
      table = locks[kind]
      raise "unsupported lock kind: #{kind}" unless table.is_a?(Hash)
      id = args["id"].to_i
      unless enabled
        table.delete(id)
        return { "kind" => kind, "id" => id, "enabled" => false, "value" => nil }
      end
      value = coerce_lock_value(kind, args["value"])
      table[id] = value
      { "kind" => kind, "id" => id, "enabled" => true, "value" => value }
    end

    def lock_clear(args)
      kind = args["kind"]
      locks = value_locks
      if kind.nil? || kind.to_s.empty?
        locks["gold"] = nil
        LOCK_KINDS.each { |k| locks[k] = {} }
        return { "cleared" => "all", "locks" => snapshot_value_locks }
      end
      kind = kind.to_s
      if kind == "gold"
        locks["gold"] = nil
      elsif LOCK_KINDS.include?(kind)
        locks[kind] = {}
      else
        raise "unsupported lock kind: #{kind}"
      end
      { "cleared" => kind, "locks" => snapshot_value_locks }
    end

    # Bulk restore from the GUI's saved lock set; `line` is the raw request
    # because the shape is too nested for parse_args.
    def lock_replace(line)
      incoming = parse_locks(line)
      locks = value_locks
      LOCK_KINDS.each do |kind|
        table = {}
        source = incoming[kind]
        if source.is_a?(Hash)
          source.each_pair do |id, raw|
            table[id] = coerce_lock_value(kind, raw)
          end
        end
        locks[kind] = table
      end
      gold = incoming["gold"]
      locks["gold"] = gold.nil? ? nil : [gold.to_i, 0].max
      { "locks" => snapshot_value_locks }
    end

    # --- battle commands ----------------------------------------------------------
    # XP's Game_Troop calls its enemy list `enemies`, VX/Ace call it `members`.
    def troop_enemies
      troop = $game_troop
      return [] unless troop
      if troop.respond_to?(:members)
        troop.members || []
      elsif troop.respond_to?(:enemies)
        troop.enemies || []
      else
        []
      end
    rescue Exception
      []
    end

    def battle_info
      entries = []
      index = 0
      troop_enemies.each do |enemy|
        entries << {
          "index" => index,
          "name" => safe(enemy, :name),
          "hp" => first_int(enemy, [:hp]),
          "mhp" => first_int(enemy, [:mhp, :maxhp])
        }
        index += 1
      end
      { "inBattle" => in_battle?, "enemies" => entries }
    end

    def battle_enemy_set_hp(args)
      index = args["index"].to_i
      enemy = troop_enemies[index]
      raise "enemy index #{index} is unavailable" unless enemy
      value = args["value"].to_i
      value = 0 if value < 0
      max = first_int(enemy, [:mhp, :maxhp])
      value = max if max > 0 && value > max
      with_suppression { enemy.hp = value }
      { "index" => index, "hp" => first_int(enemy, [:hp]) }
    end

    def battle_kill_enemies
      killed = 0
      troop_enemies.each do |enemy|
        next unless battler_alive?(enemy)
        kill_battler(enemy)
        # Verify by HP, not by dead-state: some games apply the death state a
        # frame later (custom refresh), so dead?/exist? can still report
        # "alive" inside this same tick.
        killed += 1 if battler_hp(enemy) <= 0
      end
      remaining = 0
      troop_enemies.each { |enemy| remaining += 1 if battler_hp(enemy) > 0 }
      { "killed" => killed, "remaining" => remaining }
    end

    def battle_escape
      raise "not in battle" unless in_battle?
      if rgss3?
        raise "BattleManager is unavailable" unless defined?(BattleManager)
        BattleManager.abort
        { "method" => "BattleManager.abort" }
      else
        scene = $scene
        raise "battle scene is unavailable" unless scene && scene.respond_to?(:battle_end)
        scene.battle_end(1)
        { "method" => "battle_end(1)" }
      end
    end

    # --- commands ---------------------------------------------------------------
    # Mirrors the MV/MZ bridge's command names and payload shapes. Anything RGSS
    # cannot do raises "unsupported on RGSS" so the GUI shows a clean error
    # instead of a missing handler.
    def dispatch(type, args, line = nil)
      case type

      when "ping"
        state_payload

      when "runtime.info"
        { "bridgeVersion" => VERSION, "engine" => { "maker" => engine_label },
          "gameKey" => @game_key, "options" => options }

      # --- trainer options / hooks ------------------------------------------------
      when "trainer.options.get"
        { "options" => options, "hooks" => hook_targets }
      when "trainer.options.set"
        { "options" => set_options(args) }
      when "trainer.hooks.info"
        { "options" => options, "hooks" => hook_targets,
          "hookTargets" => hook_targets, "rateStats" => {}, "battleStats" => {} }

      when "console.eval"
        code = args["code"].to_s
        raise "code is empty" if code.strip.empty?
        { "result" => eval(code).inspect }

      # --- gold ---------------------------------------------------------------
      when "gold.add"
        party = party!
        party.gain_gold(args["amount"].to_i)
        { "gold" => party.gold.to_i }
      when "gold.set"
        party = party!
        value = args["value"].to_i
        value = 0 if value < 0
        party.gain_gold(value - party.gold.to_i)
        { "gold" => party.gold.to_i }

      # --- catalogs / inventory -------------------------------------------------
      when "catalog.query"
        catalog_query(args)
      when "item.list"
        item_list
      when "item.add"
        kind = args["kind"].to_s
        kind = "item" unless ITEM_BAG_IVARS[kind]
        id = args["id"].to_i
        amount = args["amount"].to_i
        raise "amount must be a non-zero number" if amount == 0
        gain_entry(kind, id, amount)
        { "kind" => kind, "id" => id, "amount" => amount }
      when "item.set"
        item_set(args)

      # --- party ------------------------------------------------------------------
      when "party.info"
        party = party!
        members = party_members(party).map { |a| actor_info(a) }
        { "gold" => party.gold.to_i, "members" => members,
          "battleMembers" => members, "maxBattleMembers" => nil }
      when "party.recover"
        party = party!
        members = party_members(party)
        members.each { |actor| actor.recover_all if actor.respond_to?(:recover_all) }
        { "recovered" => members.length,
          "members" => members.map { |a| actor_info(a) } }
      when "party.addActor"
        party = party!
        id = args["id"].to_i
        party.add_actor(id)
        { "id" => id, "actor" => actor_info(require_actor(id)) }
      when "party.removeActor"
        party = party!
        id = args["id"].to_i
        party.remove_actor(id)
        { "id" => id }

      # --- actors -----------------------------------------------------------------
      when "actor.info"
        { "actor" => actor_info(require_actor(args["id"].to_i)) }
      when "actor.recover"
        actor = require_actor(args["id"].to_i)
        actor.recover_all if actor.respond_to?(:recover_all)
        { "actor" => actor_info(actor) }
      when "actor.level.set"
        actor = require_actor(args["id"].to_i)
        actor_set_level(actor, args["level"].to_i)
        { "actor" => actor_info(actor) }
      when "actor.exp.add"
        actor = require_actor(args["id"].to_i)
        amount = args["amount"].to_i
        actor_add_exp(actor, amount)
        { "actor" => actor_info(actor), "amount" => amount }
      when "actor.vitals.set"
        actor = require_actor(args["id"].to_i)
        # Deliberate trainer writes must land even when a lock option is on.
        with_suppression do
          if present(args["hp"]) && actor.respond_to?(:hp=)
            max = first_int(actor, [:maxhp, :mhp])
            value = args["hp"].to_i
            value = max if max > 0 && value > max
            value = 0 if value < 0
            actor.hp = value
          end
          if present(args["mp"])
            setter = actor.respond_to?(:mp=) ? :mp= : (actor.respond_to?(:sp=) ? :sp= : nil)
            if setter
              max = first_int(actor, [:maxmp, :maxsp, :mmp])
              value = args["mp"].to_i
              value = max if max > 0 && value > max
              value = 0 if value < 0
              actor.send(setter, value)
            end
          end
          if present(args["tp"]) && actor.respond_to?(:tp=)
            value = args["tp"].to_i
            value = 100 if value > 100
            value = 0 if value < 0
            actor.tp = value
          end
        end
        { "actor" => actor_info(actor) }
      when "actor.name.set"
        actor = require_actor(args["id"].to_i)
        raise "name write is unavailable" unless actor.respond_to?(:name=)
        actor.name = args["name"].to_s
        { "actor" => actor_info(actor) }
      when "actor.nickname.set"
        actor = require_actor(args["id"].to_i)
        raise "unsupported on RGSS: nicknames need VX Ace" unless actor.respond_to?(:nickname=)
        actor.nickname = args["nickname"].to_s
        { "actor" => actor_info(actor) }
      when "actor.class.set"
        actor = require_actor(args["id"].to_i)
        class_id = args["classId"].to_i
        if actor.respond_to?(:change_class)
          actor.change_class(class_id, true)
        elsif actor.respond_to?(:class_id=)
          actor.class_id = class_id
        else
          raise "unsupported on RGSS: class change is unavailable"
        end
        { "actor" => actor_info(actor) }
      when "actor.skill.learn"
        actor = require_actor(args["id"].to_i)
        skill_id = args["skillId"].to_i
        raise "learn_skill is unavailable" unless actor.respond_to?(:learn_skill)
        actor.learn_skill(skill_id)
        { "actor" => actor_info(actor), "skillId" => skill_id }
      when "actor.skill.forget"
        actor = require_actor(args["id"].to_i)
        skill_id = args["skillId"].to_i
        raise "forget_skill is unavailable" unless actor.respond_to?(:forget_skill)
        actor.forget_skill(skill_id)
        { "actor" => actor_info(actor), "skillId" => skill_id }
      when "actor.state.add"
        actor = require_actor(args["id"].to_i)
        state_id = args["stateId"].to_i
        actor.add_state(state_id)
        { "actor" => actor_info(actor) }
      when "actor.state.remove"
        actor = require_actor(args["id"].to_i)
        state_id = args["stateId"].to_i
        actor.remove_state(state_id)
        { "actor" => actor_info(actor) }
      when "actor.param.add"
        actor = require_actor(args["id"].to_i)
        raise "unsupported on RGSS: add_param needs VX Ace" unless actor.respond_to?(:add_param)
        param_id = args["paramId"].to_i
        value = args["value"].to_i
        actor.add_param(param_id, value)
        { "actor" => actor_info(actor), "paramId" => param_id, "value" => value }

      # --- switches / variables -----------------------------------------------------
      when "switch.list"
        flag_list("switch", args)
      when "switch.set"
        flag_set("switch", args)
      when "variable.list"
        flag_list("variable", args)
      when "variable.set"
        flag_set("variable", args)
      when "selfSwitch.list"
        self_switch_list(args)
      when "selfSwitch.set"
        self_switch_set(args)

      # --- maps -----------------------------------------------------------------------
      when "map.info"
        map_info_payload || {}
      when "map.list"
        map_list
      when "map.transfer"
        map_transfer(args)

      # --- save slots -----------------------------------------------------------------
      when "save.list"
        save_list
      when "save.save"
        save_save(args["id"] ? args["id"].to_i : 1)
      when "save.load"
        save_load(args["id"].to_i)

      # --- save contents tree (数据修改) -------------------------------------------------
      when "save.contents.get"
        save_contents_get(args)
      when "save.contents.apply"
        save_contents_apply(line.to_s)

      # --- value locks --------------------------------------------------------------
      when "lock.list"
        { "locks" => snapshot_value_locks,
          "stats" => { "applied" => @lock_apply_count } }
      when "lock.set"
        lock_set(args)
      when "lock.clear"
        lock_clear(args)
      when "lock.replace"
        lock_replace(line.to_s)

      # --- battle -------------------------------------------------------------------
      when "battle.info"
        battle_info
      when "battle.enemy.setHp"
        battle_enemy_set_hp(args)
      when "battle.killEnemies"
        battle_kill_enemies
      when "battle.escape"
        battle_escape

      # --- scenes (push/pop are MV/MZ-only) --------------------------------------------
      when "scene.info"
        { "available" => [] }

      else
        raise "unsupported on RGSS: #{type}"
      end
    end
  end
end

# Placeholders are substituted by core/rgss.mjs at injection time.
RMCH.configure(__RMCH_PORT__, __RMCH_TOKEN__, __RMCH_GAMEKEY__, __RMCH_REALDIR__, __RMCH_CHANNELDIR__)

# --- main-loop hook ---------------------------------------------------------
# Connect on the first frame, then pump the command file once per frame.
# NB: define via Object.define_method, NOT a plain top-level `def` — the
# RGSS attach path evals this source through RGSSEval, whose cref is NOT
# Object (a plain `def` would land on an invisible context and the calls
# below would raise NoMethodError on main). Blocks also cannot `return`,
# hence `next`.
Object.send(:define_method, :rmch_pump) do
  unless RMCH.started
    RMCH.connect
    next
  end
  RMCH.pump
end

Object.send(:define_method, :rmch_hook_update) do |site|
  site.class_eval do
    unless instance_methods(false).map { |m| m.to_s }.include?("rmch_update_orig")
      # Capture the current `update` as an UnboundMethod and have the wrapper
      # call THAT — never the `rmch_update_orig` alias by name. When a hooked
      # subclass's update calls `super`, the parent wrapper runs with self
      # still being the subclass instance; a by-name alias call would then
      # re-resolve to the SUBCLASS alias and bounce between the two wrappers
      # until SystemStackError ("stack level too deep"). Star Stealing
      # Prince's Paradog Scene_Title#update -> super hits exactly this. A
      # captured UnboundMethod always runs the method body seen at hook time,
      # which breaks the cycle. `rmch_update_orig` stays as a hooked-marker
      # (and for debugging) but is never invoked.
      rmch_orig = instance_method(:update)
      alias_method :rmch_update_orig, :update
      define_method(:update) do |*args|
        begin
          rmch_pump
        rescue Exception
        end
        # A scene update that raises takes the whole RGSS main loop down with
        # it (and the bridge with that). Report before re-raising so the host
        # can see what actually broke.
        begin
          rmch_orig.bind(self).call(*args)
        rescue Exception => e
          RMCH.report_game_error(e)
          raise
        end
      end
    end
  end
end

# Hook the per-frame pump into scene updates. Scene_Base alone is NOT enough:
# custom engines (BLACK SOULS included) override `update` in subclasses and
# never call super, which would bypass a base-class hook entirely — so hook
# every Scene_Base descendant that defines its own update as well. A subclass
# that does call super pumps twice per frame; connect/pump are idempotent and
# offset-guarded, so that is harmless. Hooking both parent and child is safe
# only because the wrapper calls a captured UnboundMethod (see above) — with
# a plain alias-chain, child `super` + parent wrapper recurses forever.
if defined?(Scene_Base)
  rmch_hook_update(Scene_Base)
  ObjectSpace.each_object(Class) do |klass|
    next unless klass < Scene_Base
    next unless klass.instance_methods(false).map { |m| m.to_s }.include?("update")
    rmch_hook_update(klass)
  end
else
  # XP has no Scene_Base: hook every Scene_* class that defines its own
  # update (inherited updates resolve to an already-hooked parent).
  ObjectSpace.each_object(Class) do |klass|
    next unless klass.to_s =~ /^Scene_/
    next unless klass.instance_methods(false).map { |m| m.to_s }.include?("update")
    rmch_hook_update(klass)
  end
end
