# Architecture Decision Records

These are short, append-only notes recording **why** a significant technical
choice was made — the forces in play, the options weighed, and what was
rejected. The code tells you *what* the system does today; an ADR tells you *why*
it got that way, so a future reader (including future us) doesn't relitigate a
settled decision or accidentally revert it without knowing the cost.

Conventions:

- One file per decision, numbered: `NNNN-short-title.md`.
- Records are **immutable**. Don't rewrite history — if a decision changes,
  add a new ADR and mark the old one `Superseded by ADR-XXXX`.
- Status is one of: `Proposed`, `Accepted`, `Superseded`, `Deprecated`.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-node-python-asr-bridge.md) | How Node.js calls the Python ASR model | Accepted |
