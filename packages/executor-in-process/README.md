# @pactmark/executor-in-process

This package executes only host-declared tool callbacks and provides deny-all or declared-origin egress brokers. It does not claim process isolation or enforced network containment. Its capability snapshot reports `sandbox: "unsafe_local"` and at most `networkPolicy: "declared"`.

Use a separately isolated host adapter that passes Pactmark's enforced executor/egress conformance suite before advertising `networkPolicy: "enforced"`.

Version `0.2.0` is publicly released with independently verified registry bytes
and npm SLSA provenance. The package remains an unsafe local executor and does
not provide production isolation.
