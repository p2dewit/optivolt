# Native parallel HiGHS bridge

This directory builds a Linux x86_64 executable that adapts HiGHS to the
request and response format used by `api/services/solve-worker.ts`.

The build pins upstream HiGHS v1.15.1. The repository's existing `highs`
WebAssembly dependency is v1.8.0 and does not include parallel MIP tree
search. The native bridge reads the SOLVER settings sent with each solve:
multi-threading can be enabled or disabled, and the maximum thread count is
bounded by the CPUs available to the OptiVolt process. OptiVolt's time and gap
options and optional sparse warm start are applied as before.

## Build

Requirements: Docker Desktop with Buildx and an internet connection. From the
OptiVolt repository root, run:

```sh
sh native/highs/build-linux-amd64.sh
```

The script builds in a Debian 13 Linux container and writes the executable to
`native/highs/bin/highs-native-bridge`. The binary is intentionally ignored by
Git; reproduce it from the pinned source using the script when needed.

## OptiVolt integration

The solve worker checks for `native/highs/bin/highs-native-bridge` and uses it
when present. Set `OPTIVOLT_HIGHS_NATIVE_PATH` to override that path. If the
binary is absent, the existing WebAssembly solver remains the fallback.

The bridge reads one JSON request from stdin with `lpText`, `options`, an
optional `warmColumns` object, and `solverSettings` (`multiThreadingEnabled`
and `maxThreads`). It writes a JSON result with the same
`Status`, `ObjectiveValue`, and `Columns` structure used by the current
planner. Solver diagnostics and errors go to stderr.

The `--capabilities` command reports whether the installed bridge supports
per-solve thread settings. The Settings tab's **Find optimum** benchmark checks
this capability before comparing single-threaded and parallel configurations.
