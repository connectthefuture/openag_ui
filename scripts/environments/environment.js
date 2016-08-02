import * as Config from '../../openag-config.json';
import {html, forward, Effects, Task, thunk} from 'reflex';
import {merge, tagged, tag, batch} from '../common/prelude';
import * as Poll from '../common/poll';
import * as Template from '../common/stache';
import * as Request from '../common/request';
import * as Result from '../common/result';
import * as Unknown from '../common/unknown';
import {cursor} from '../common/cursor';
import {localize} from '../common/lang';
import {compose, constant} from '../lang/functional';
import * as Chart from '../environments/chart';
import * as Toolbox from '../environments/toolbox';
import * as Exporter from '../environments/exporter';

const S_MS = 1000;
const MIN_MS = S_MS * 60;
const HR_MS = MIN_MS * 60;
const DAY_MS = HR_MS * 24;

const POLL_TIMEOUT = 4 * S_MS;
const RETRY_TIMEOUT = 4 * S_MS;

const MAX_DATAPOINTS = 5000;

// Actions

const NoOp = {
  type: 'NoOp'
};

const TagExporter = tag('Exporter');
const OpenExporter = TagExporter(Exporter.Open);

const TagToolbox = action =>
  action.type === 'OpenExporter' ?
  OpenExporter :
  tagged('Toolbox', action);

const TagPoll = action =>
  action.type === 'Ping' ?
  FetchLatest :
  tagged('Poll', action);

const FetchLatest = {type: 'FetchLatest'};
const Latest = tag('Latest');

const FetchRestore = tag('FetchRestore');
const Restore = tag('Restore');

const PongPoll = TagPoll(Poll.Pong);
const MissPoll = TagPoll(Poll.Miss);

const TagChart = tag('Chart');
const AddChartData = compose(TagChart, Chart.AddData);
const ChartLoading = compose(TagChart, Chart.Loading);

// Send an alert. We use this to send up problems to be displayed in banner.
const AlertBanner = tag('AlertBanner');
// Suppress a previously sent alert.
const SuppressBanner = {type: 'SuppressBanner'};

// Map an incoming datapoint into an action
const DataPointAction = dataPoint => {
  console.log(DataPoint);
}

// Model init and update

export const init = id => {
  const [poll, pollFx] = Poll.init(POLL_TIMEOUT);
  const [chart, chartFx] = Chart.init();
  const [exporter, exporterFx] = Exporter.init();

  return [
    {
      id,
      chart,
      poll,
      exporter
    },
    Effects.batch([
      chartFx.map(TagChart),
      pollFx.map(TagPoll),
      exporterFx.map(TagExporter),
      Effects.receive(FetchRestore(id))
    ])
  ];
};

export const update = (model, action) =>
  action.type === 'NoOp' ?
  [model, Effects.none] :
  action.type === 'Poll' ?
  updatePoll(model, action.source) :
  action.type === 'Exporter' ?
  updateExporter(model, action.source) :
  action.type === 'Chart' ?
  updateChart(model, action.source) :
  action.type === 'FetchLatest' ?
  [model, Request.get(templateLatestUrl(model.id)).map(Latest)] :
  action.type === 'FetchRestore' ?
  [model, Request.get(templateRecentUrl(model.id)).map(Restore)] :
  action.type === 'Restore' ?
  restore(model, action.source) :
  action.type === 'Latest' ?
  updateLatest(model, action.source) :
  Unknown.update(model, action);

const updateLatest = Result.updater(
  (model, record) => {
    const [next, fx] = batch(update, model, [
      AddChartData(readData(record)),
      PongPoll
    ]);

    return [
      next,
      Effects.batch([
        fx,
        // Suppress any banners.
        Effects.receive(SuppressBanner)
      ])
    ];
  },
  (model, error) => {
    // Send miss poll
    const [next, fx] = update(model, MissPoll);

    // Create alert action
    const action = AlertBanner(error);

    return [
      next,
      // Batch any effect generated by MissPoll with the alert effect.
      Effects.batch([
        fx,
        Effects.receive(action)
      ])
    ];
  }
);

const restore = Result.updater(
  (model, record) => {
    const [next, fx] = batch(update, model, [
      AddChartData(readData(record)),
      FetchLatest
    ]);

    return [
      next,
      Effects.batch([
        fx,
        // Suppress any banners.
        Effects.receive(SuppressBanner)
      ])
    ];
  },
  (model, error) => {
    const action = AlertBanner(error);

    return [
      model,
      Effects.batch([
        // Wait for a second, then try to restore again.
        Effects.perform(Task.sleep(RETRY_TIMEOUT)).map(FetchRestore),
        Effects.receive(action)
      ])
    ];
  }
);

const updateChart = cursor({
  get: model => model.chart,
  set: (model, chart) => merge(model, {chart}),
  update: Chart.update,
  tag: TagChart
});

const updateExporter = cursor({
  get: model => model.exporter,
  set: (model, exporter) => merge(model, {exporter}),
  update: Exporter.update,
  tag: TagExporter
});

const updatePoll = cursor({
  get: model => model.poll,
  set: (model, poll) => merge(model, {poll}),
  update: Poll.update,
  tag: TagPoll
});

// View

export const view = (model, address) =>
  html.div({
    className: 'environment-main'
  }, [
    thunk('chart', Chart.view, model.chart, forward(address, TagChart)),
    thunk('chart-toolbox', Toolbox.view, model, forward(address, TagToolbox)),
    thunk(
      'chart-export',
      Exporter.view,
      model.exporter,
      forward(address, TagExporter),
      model.id
    )
  ]);

// Helpers

const readRow = row => row.value;
// @FIXME must check that the value returned from http call is JSON and has
// this structure before mapping.
const readRecord = record => record.rows.map(readRow);

const compareByTimestamp = (a, b) =>
  a.timestamp > b.timestamp ? 1 : -1;

const readDataPoint = ({variable, is_desired, timestamp, value}) => ({
  variable,
  timestamp,
  is_desired,
  value: Number.parseFloat(value)
});

const readData = record => {
  const data = readRecord(record).map(readDataPoint);
  data.sort(compareByTimestamp);
  return data;
};

// Create a url string that allows you to GET latest environmental datapoints
// from an environmen via CouchDB.
const templateLatestUrl = (environmentID) =>
  Template.render(Config.environmental_data_point.origin_latest, {
    origin_url: Config.origin_url,
    startkey: JSON.stringify([environmentID]),
    endkey: JSON.stringify([environmentID, {}])
  });

const templateRecentUrl = (environmentID) =>
  Template.render(Config.environmental_data_point.origin_range, {
    origin_url: Config.origin_url,
    startkey: JSON.stringify([environmentID, {}]),
    endkey: JSON.stringify([environmentID]),
    limit: MAX_DATAPOINTS,
    descending: true
  });
