# Architecture Decision Records

These are short notes recording **why** a significant technical choice was made —
the forces in play, the benefits it brings, and the alternatives rejected. The
code tells you *what* the system does; an ADR tells you *why*, so a visitor (or
future us) can understand the design and the trade-offs without reverse-engineering
them, and not undo a deliberate choice without knowing its cost.

Conventions:

- One file per decision, numbered: `NNNN-short-title.md`.
- Focus on rationale and benefits, not chronology. If a decision is later
  replaced, add a new ADR and mark the old one `Superseded by ADR-XXXX`.
- Status is one of: `Proposed`, `Accepted`, `Superseded`, `Deprecated`.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-node-python-asr-bridge.md) | How Node.js calls the Python ASR model | Accepted |
