# AGENTS.md

Agent guidance for this repository. See also `CLAUDE.md` for architecture, constraints, and development workflow.

## Use the code graph

This repo ships a [Graphify](https://pypi.org/project/graphifyy/) code graph at `graphify-out/graph.json`.

Before broad grepping the tree, start from the Graphify CLI against that graph:

- `graphify query` — find symbols and relationships by name or intent
- `graphify path` — trace how code connects between two points
- `graphify explain` — summarize what a file or symbol does in context

When you change structure (new modules, moved files, renamed exports), refresh the graph in the **same PR** with:

```sh
graphify . --code-only --no-cluster --update
```

Never rebuild from scratch on a feature branch (`graphify .` without `--update` drops incremental cache benefits). Full rebuilds from scratch belong on `main` only, after merge.

Install the tool once: `pip install graphifyy` (CLI command: `graphify`).
