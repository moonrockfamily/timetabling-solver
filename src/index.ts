/// <reference path="./genetic-js-no-ww.d.ts" />
// top-level aggregator module: the library's public API surface.  Most of the
// heavy lifting has been pulled into well-scoped submodules; this file simply
// re-exports them so users can import everything from `timetabling-solver`.

import {
  runMetaGA,
  ParamSpec,
  ParamSet,
  MetaOptions,
  MetaResult,
} from './metaOptimizer';

// re-export underlying utilities for convenience
export { runMetaGA, ParamSpec, ParamSet, MetaOptions, MetaResult };

// core domain modules
export * from './constraints';
export * from './rules';
export * from './scheduler';
export * from './tuning';
export * from './ics';
export * from './constants';

// There used to be an inlined "sample" script here, but it's been moved to a
// standalone example file (e.g. `examples/sample.ts`) to keep the primary
// entrypoint focussed on library exports.

