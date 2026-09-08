load File.expand_path('event-tools.rb',File.dirname(__FILE__))
source=File.read(File.expand_path('../../runtime/rgss-bridge/bridge.rb',File.dirname(__FILE__)))
body=source[source.index('    def ex_main')...source.index('    # --- save slots')]
module RMCH
  class EventExecutionStop < StandardError; end
  def self.rgss3?; generation==3; end
end
RMCH.singleton_class.class_eval(body)
module RPG
  class EventCommand
    attr_accessor :code,:indent,:parameters
    def initialize(code=0,indent=0,parameters=[]);@code=code;@indent=indent;@parameters=parameters;end
  end
end
class NativeLegacy
  def initialize(depth=0);@depth=depth;@list=nil;end
  def setup(list,event_id=0);@list=list;@index=0;@event_id=event_id;@wait_count=0;@child_interpreter=nil;end
  def running?;!!@list;end
  def update
    loop do
      if @child_interpreter
        @child_interpreter.update
        return if @child_interpreter.running?
        @child_interpreter=nil
      end
      if @wait_count && @wait_count>0;@wait_count-=1;return;end
      return unless @list
      return unless execute_command
      @index+=1
    end
  end
  def execute_command
    c=@list[@index];unless c;@list=nil;return false;end
    @indent=c.indent
    if RMCH.rgss1?;@parameters=c.parameters;else;@params=c.parameters;end
    send('command_'+c.code.to_s)
  end
  def parameters;RMCH.rgss1? ? @parameters : @params;end
  def command_0;@list=nil;false;end
  def command_125;$coins+=parameters[2];true;end
  def command_112;true;end
  def command_108;true;end
  def command_413
    begin;@index-=1;end until @list[@index].indent==@indent
    true
  end
  def command_230;@wait_count=parameters[0];true;end
  def command_117;raise 'owned common call must use its validated snapshot';end
  def command_123;true;end
  def get_character(id);$game_player;end
  def command_205;$game_player.instance_variable_set(:@move_route_forcing,true);true;end
  def command_209;command_205;end
  def command_119;true;end
  def command_355
    text=parameters[0]+"\n"
    while @list[@index+1] && @list[@index+1].code==655
      @index+=1;text+=@list[@index].parameters[0]+"\n"
    end
    eval(text);true
  end
end
class NativeXP < NativeLegacy;end
class NativeVX < NativeLegacy;end
class NativeAce < NativeLegacy
  def setup(list,event_id=0);super;@fiber=Fiber.new {run};end
  def running?;!!@fiber;end
  def update;@fiber.resume if @fiber;end
  def run
    while @list && @index<@list.size
      execute_command
      @index+=1
    end
    @fiber=nil
  end
  def command_230;parameters[0].times {Fiber.yield};true;end
end
def c(code,parameters=[],indent=0);RPG::EventCommand.new(code,indent,parameters);end
[NativeXP,NativeVX,NativeAce].each_with_index do |klass,n|
  RMCH.generation=n+1;RMCH.instance_variable_set(:@ex_session,nil)
  $coins=0;$scene=Scene_Map.new;$game_temp=FixtureObject.new;$game_player=Player.new
  main=klass.new;$game_map=MapAce.new(:map=>Object.new,:events=>{},:interpreter=>main)
  $data_common_events=[nil,
    FixtureObject.new(:name=>'Gold',:list=>[c(125,[0,0,10]),c(125,[0,0,20]),c(0)]),
    FixtureObject.new(:name=>'Loop',:list=>[c(112),c(125,[0,0,1],1),c(230,[2],1),c(413),c(0)]),
    FixtureObject.new(:name=>'Child',:list=>[c(117,[2]),c(125,[0,0,900]),c(0)]),
    FixtureObject.new(:name=>'Script',:list=>[c(355,['$coins+=5']),c(655,['$coins+=6']),c(0)]),
    FixtureObject.new(:name=>'Unavailable',:list=>[c(123,['A',0]),c(9999),c(119,['outside']),c(0)])]
  token=RMCH.et_context[1]
  start=lambda do |id,offset,confirmed|
    plan=RMCH.ex_plan(id,offset)
    RMCH.ex_dispatch('events.execute',{'mapToken'=>token,'id'=>id.to_s,'start'=>offset.to_s,'revision'=>plan['revision'],'confirmed'=>confirmed.to_s})
  end
  result=start.call(1,1,false)
  raise 'accepted should not mean completed' unless result['execution']['state']=='accepted' && $coins==0
  expect_error {start.call(1,0,false)}
  # The source can change after acceptance without altering this execution.
  $data_common_events[1].instance_variable_get(:@list)[1].parameters[2]=2000
  main.update
  raise 'selected range or snapshot broken' unless $coins==20 && RMCH.ex_public['execution']['state']=='completed'
  steps=RMCH.ex_dispatch('events.steps',{'mapToken'=>token,'id'=>'5'})['steps']
  raise 'unsupported contexts must be explained' unless steps.all? {|s|s['reason']}
  expect_error {start.call(4,0,false)}
  start.call(4,0,true);main.update;raise 'script continuation lost' unless $coins==31
  start.call(3,0,false);main.update;raise 'child did not run' unless $coins==32
  execution=RMCH.ex_public['execution']
  RMCH.ex_dispatch('events.stop',{'executionId'=>execution['id']})
  raise 'stop declared prematurely' unless RMCH.ex_public['execution']['state']=='stopping'
  5.times {main.update}
  raise 'stopping child ran extra effects' unless $coins==32 && RMCH.ex_public['execution']['state']=='stopped'
  $data_common_events[2].instance_variable_set(:@list,[c(112),c(108,['loop'],1),c(125,[0,0,1],1),c(413),c(0)])
  start.call(2,0,false);main.update
  raise 'loop did not yield' unless $coins>32 && $coins<200
  before_stop=$coins
  RMCH.ex_dispatch('events.stop',{'executionId'=>RMCH.ex_public['execution']['id']});main.update
  raise 'loop stop failed' unless RMCH.ex_public['execution']['state']=='stopped'
  raise 'budget resume ran another command after stop' unless $coins==before_stop
  Marshal.dump(main) # Hooks must not make the saved interpreter unmarshalable.
  route=FixtureObject.new(:list=>[c(0)],:wait=>false,:repeat=>false)
  $data_common_events[1].instance_variable_set(:@list,[c(n==0 ? 209 : 205,[-1,route]),c(0)])
  start.call(1,0,false);main.update
  raise 'movement ended too early' unless RMCH.ex_active?
  RMCH.ex_dispatch('events.stop',{'executionId'=>RMCH.ex_public['execution']['id']});main.update
  raise 'stop ignored movement' unless RMCH.ex_public['execution']['state']=='stopping'
  $game_player.instance_variable_set(:@move_route_forcing,false);main.update
  raise 'movement stop failed' unless RMCH.ex_public['execution']['state']=='stopped'
  route.instance_variable_set(:@list,[c(45,['dangerous_route_script()'])])
  raise 'route script confirmation absent' unless RMCH.ex_plan(1,0)['script']
  puts "RGSS#{n+1} execution fixture PASS: range, snapshot, child, wait, stop, loop budget, Marshal"
end
