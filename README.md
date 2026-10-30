# web-tool-mcp

A stdio MCP server derived from `web-search-mcp` that separates lightweight discovery from on-demand page reading.

## Tools

### `web_search`

Searches through the inherited Bing → Brave → DuckDuckGo backend and returns only titles, URLs, and search snippets (five results by default). It does not fetch result pages. Query syntax is passed to the backend; operators such as `site:`, `filetype:`, `intitle:`, exclusions, and exact phrases work when supported by the selected engine.

### `web_extract`

Fetches one to five supplied HTTP(S) URLs and returns cleaned page text with headings and links. It uses an inline character budget of 15,000 per page by default. Longer pages return a head-and-tail window and save the complete extracted text under the OS temporary directory (`WEB_EXTRACT_SAVE_DIR` can override it), with a path and a `read_file` paging hint. Images appear as `[IMAGE: alt]` placeholders with image links where available. HTML extraction tries HTTP first and the inherited browser extractor as a fallback. PDF URLs are recognized but PDF text extraction is not implemented in this build. Pages requiring JavaScript, login, or interaction may still need a browser tool.

## Run

Requires Node.js 24+.

```sh
npm install
npm install-scripts approve esbuild
npm install
npx playwright install
npm run build
# Test
npx @modelcontextprotocol/inspector node dist/index.js
```

or 

```sh
pnpm install
pnpm approve-builds
pnpm install
pnpm dlx playwright install
pnpm run build
# Test
pnpm dlx @modelcontextprotocol/inspector node dist/index.js
```

If you want to use firefox;
```sh
pnpm dlx @modelcontextprotocol/inspector -e BROWSER_TYPES=firefox node dist/index.js
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "web-tool": {
      "command": "node",
      "args": ["/path/to/web-tool-mcp/dist/index.js"]
    }
  }
}
```

Useful environment settings inherited from the base project include `DEFAULT_TIMEOUT`, `BROWSER_HEADLESS`, `BROWSER_TYPES`, `BROWSER_FALLBACK_THRESHOLD`, `ENABLE_RELEVANCE_CHECKING`, and `FORCE_MULTI_ENGINE_SEARCH`.
