# Review

This folder holds one review packet per release, named after the version it covers.

A review packet records what was checked before the release, what was not checked, and what is
known to be outstanding. The second and third parts matter most. A packet that lists only what
passed reads like a changelog, and the things nobody looked at are exactly what a reader needs to be
told about.

This project declares stakes `real` (ADR-001). At that level, a second person must answer the
packet's questions for every load-bearing surface, working independently of the first reviewer,
before the release ships.
