# Reference Corpus Harness

`synthetic-decay.json` is a deterministic algorithm-regression fixture. It is not an independent accuracy reference.

The manifest deliberately starts with an empty external/inter-laboratory section. Add an external artifact only when its license permits redistribution, provenance is traceable, a SHA-256 hash is pinned, calibration and uncertainty metadata are available, and a regression tolerance has been justified before seeing the result under test.

Run `npm run corpus:verify` to check hashes, paths, provenance fields, licenses, and independence gates. Two separately produced traceable datasets are required before the harness reports inter-laboratory readiness.
