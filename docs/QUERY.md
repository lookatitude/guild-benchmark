# Querying Benchmark Knowledge

Only one knowledge page exists today
(`research/benchmark-datasets-fixtures.md`), so a directory scan is enough.

## ripgrep recipes

```bash
# Full-text search across all benchmark knowledge
rg -i "fixture taxonomy" benchmark/docs/

# List every knowledge page
rg --files benchmark/docs/ -g '*.md'

# Find pages by frontmatter field (e.g. confidence)
rg -n "^confidence:" benchmark/docs/

# Show a page's frontmatter block
rg -n -U "^---.*?---" benchmark/docs/research/benchmark-datasets-fixtures.md
```

## guild-memory MCP

The optional guild-memory MCP server can index this tree directly by pointing
its wiki root at `benchmark/docs/`:

```bash
GUILD_MEMORY_WIKI_ROOT=/Users/miguelp/Projects/guild/benchmark/docs
```

With that env var set, BM25 search / read / list tools operate over the
benchmark knowledge instead of the consuming repo's `.guild/wiki/`.
