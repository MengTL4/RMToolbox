import type { Component } from 'vue';
declare global {
  interface Window { RMCH: { parts: Record<string, Component>; views: Record<string, Component>; App: Component; Shell: Component; Icon: Component } }
}

// Initialize the shared store once, then load the explicit component graph.
import '../ui/compat.js';
import '../ui/theme.js';
import '../ui/store/core.js';
import '../ui/store/trainer.js';
import '../ui/store/data.js';
import '../ui/store/locks.js';
import '../ui/store/library.js';
import '../ui/store/saves.js';
import RmIcon from './shell/RmIcon.vue';
import RmEntryList from './parts/RmEntryList.vue';
import RmGameIcon from './parts/RmGameIcon.vue';
import RmJsonEditor from './parts/RmJsonEditor.vue';
import RmPicker from './parts/RmPicker.vue';
import RmVirtual from './parts/RmVirtual.vue';
import CheatToggles from './panels/CheatToggles.vue';
import CheatRates from './panels/CheatRates.vue';
import QuickActions from './panels/QuickActions.vue';
import BattlePanel from './panels/BattlePanel.vue';
import GoldPanel from './panels/GoldPanel.vue';
import SceneTools from './panels/SceneTools.vue';
import ConsoleView from './views/ConsoleView.vue';
import DataActorsView from './views/DataActorsView.vue';
import DataEventsView from './views/DataEventsView.vue';
import DataFlagsView from './views/DataFlagsView.vue';
import DataItemsView from './views/DataItemsView.vue';
import DataMapView from './views/DataMapView.vue';
import DataTreeView from './views/DataTreeView.vue';
import DataView from './views/DataView.vue';
import LibraryView from './views/LibraryView.vue';
import LogView from './views/LogView.vue';
import SavesView from './views/SavesView.vue';
import TrainerView from './views/TrainerView.vue';
import RmchShell from './shell/RmchShell.vue';
import RmchApp from './shell/RmchApp.vue';
import Delta from './components/Delta.vue';
import InjectionGuide from './components/InjectionGuide.vue';
import EventMiniMap from './parts/EventMiniMap.vue';
import MapEventPanel from './panels/MapEventPanel.vue';
import DataInterpreterView from './views/DataInterpreterView.vue';

// Public registry retained for the mount point and integration test harnesses.
// Components import their dependencies directly, not through this registry.
window.RMCH.parts = {};
window.RMCH.views = {};
window.RMCH.Icon = RmIcon;
window.RMCH.parts.EntryList = RmEntryList;
window.RMCH.parts.GameIcon = RmGameIcon;
window.RMCH.parts.JsonEditor = RmJsonEditor;
window.RMCH.parts.Picker = RmPicker;
window.RMCH.parts.Virtual = RmVirtual;
window.RMCH.parts.CheatToggles = CheatToggles;
window.RMCH.parts.CheatRates = CheatRates;
window.RMCH.parts.QuickActions = QuickActions;
window.RMCH.parts.BattlePanel = BattlePanel;
window.RMCH.parts.GoldPanel = GoldPanel;
window.RMCH.parts.SceneTools = SceneTools;
window.RMCH.views.Console = ConsoleView;
window.RMCH.views.DataActors = DataActorsView;
window.RMCH.views.DataEvents = DataEventsView;
window.RMCH.views.DataFlags = DataFlagsView;
window.RMCH.views.DataItems = DataItemsView;
window.RMCH.views.DataMap = DataMapView;
window.RMCH.views.DataTree = DataTreeView;
window.RMCH.views.Data = DataView;
window.RMCH.views.Library = LibraryView;
window.RMCH.views.Log = LogView;
window.RMCH.views.Saves = SavesView;
window.RMCH.views.Trainer = TrainerView;
window.RMCH.Shell = RmchShell;
window.RMCH.App = RmchApp;
window.RMCH.parts.Delta = Delta;
window.RMCH.parts.InjectionGuide = InjectionGuide;
window.RMCH.parts.EventMiniMap = EventMiniMap;
window.RMCH.parts.MapEventPanel = MapEventPanel;
window.RMCH.views.DataInterpreter = DataInterpreterView;
