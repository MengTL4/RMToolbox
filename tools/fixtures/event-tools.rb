# Exercise the shipped RGSS adapters with each engine's passage signature.
# This runs in host Ruby; real RGSS executables remain a separate smoke test.
require 'json'
source = File.read(File.expand_path('../../runtime/rgss-bridge/bridge.rb', File.dirname(__FILE__)))
body = source.split('    # Event tools use flat request fields, compatible with the RGSS1 parser.')[1].split('    def map_transfer(args)')[0]
module RMCH
  class << self
    attr_accessor :generation
    def rgss1?; generation == 1; end
    def rgss2?; generation == 2; end
    def ex_active?; false; end
    def jenc(value); JSON.generate(value); end
    def map_info_payload; {'mapId'=>1,'width'=>8,'height'=>8}; end
  end
end
RMCH.singleton_class.class_eval(body)
class Scene_Map; end
class FixtureObject
  def initialize(values = {})
    values.each { |k,v| instance_variable_set('@'+k.to_s,v) }
  end
end
class Player < FixtureObject
  attr_reader :x, :y
  def moveto(x,y); @x=x; @y=y; end
end
class MapXP < FixtureObject
  attr_accessor :blocked
  def passable?(x,y,d,event)
    raise 'wrong XP direction' unless [2,4,6,8].include?(d) && event.nil?
    !blocked
  end
end
class MapVX < FixtureObject
  attr_accessor :blocked
  def passable?(x,y,flag)
    raise 'wrong VX flag' unless flag == 1
    !blocked
  end
end
class MapAce < FixtureObject
  attr_accessor :blocked
  def passable?(x,y,d)
    raise 'wrong Ace direction' unless [2,4,6,8].include?(d)
    !blocked
  end
end
def expect_error
  caught = false
  begin; yield; rescue StandardError; caught = true; end
  raise 'expected rejection' unless caught
end
[MapXP,MapVX,MapAce].each_with_index do |klass,index|
  RMCH.generation = index+1
  conditions=FixtureObject.new(:switch1_valid=>true,:switch1_id=>1)
  commands=[FixtureObject.new(:code=>355,:indent=>0,:parameters=>['raise "must never execute"']),FixtureObject.new(:code=>9001,:indent=>1,:parameters=>[FixtureObject.new(:custom=>42)])]
  page=FixtureObject.new(:condition=>conditions,:list=>commands)
  data=FixtureObject.new(:name=>'Guard',:pages=>[page])
  event=FixtureObject.new(:id=>1,:event=>data,:page=>page,:x=>3,:y=>3,:priority_type=>1)
  $game_map=klass.new(:map=>Object.new,:events=>{1=>event})
  $game_player=Player.new
  $game_system=FixtureObject.new
  $game_temp=FixtureObject.new
  $scene=Scene_Map.new
  $game_switches=[nil,true]
  $game_variables=[]; $game_self_switches={}
  $data_common_events=[nil,FixtureObject.new(:name=>'Common',:list=>commands)]
  snapshot=RMCH.et_dispatch('map.inspect',{})
  token=snapshot['mapToken']
  args={'mapToken'=>token,'eventId'=>'1','eventToken'=>snapshot['events'][0]['eventToken']}
  raise 'passage signature' unless RMCH.et_cell(3,4)==15
  result=RMCH.et_dispatch('map.move',args)
  raise 'adjacent destination' unless result['x']==3 && result['y']==4
  $game_map.blocked=true
  expect_error { RMCH.et_move(args) }
  expect_error { RMCH.et_move(args.merge('force'=>'true')) }
  RMCH.et_move(args.merge('force'=>'true','confirmed'=>'true'))
  raise 'force coordinate' unless $game_player.y==3
  $scene=Object.new
  expect_error { RMCH.et_move(args.merge('force'=>'true','confirmed'=>'true')) }
  $scene=Scene_Map.new
  read_args={'mapToken'=>token,'kind'=>'map','id'=>'1','pageIndex'=>'0','count'=>'1'}
  read=RMCH.et_read(read_args)
  raise 'read pagination' unless read['total']==2 && read['commands'].size==1
  raise 'condition value' unless read['values']['switch:1']==true
  second=RMCH.et_read(read_args.merge('offset'=>'1','revision'=>read['revision']))
  raise 'unknown object retained' unless second['commands'][0]['parameters'][0]['custom']==42
  event.instance_variable_set('@page',nil)
  expect_error { RMCH.et_read(read_args.merge('revision'=>read['revision'])) }
  interpreter=FixtureObject.new(:list=>commands,:index=>1,:event_id=>1)
  $game_map.instance_variable_set('@interpreter',interpreter)
  run=RMCH.et_running[0]
  raise 'running cursor' unless RMCH.et_read({'mapToken'=>token,'kind'=>'running','runId'=>run['id']})['index']==1
  interpreter.instance_variable_set('@index',2)
  expect_error { RMCH.et_read({'mapToken'=>token,'kind'=>'running','runId'=>run['id']}) }
  $game_map.instance_variable_set('@map',Object.new)
  expect_error { RMCH.et_move(args.merge('force'=>'true','confirmed'=>'true')) }
  puts "RGSS#{index+1} event protocol fixture PASS"
end
