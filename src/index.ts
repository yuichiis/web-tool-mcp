#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SearchEngine } from './search-engine.js';
import { EnhancedContentExtractor } from './enhanced-content-extractor.js';
import { validateUrl } from './utils.js';

const server = new McpServer({ name: 'web-tool-mcp', version: '1.0.0' });
const searchEngine = new SearchEngine();
const extractor = new EnhancedContentExtractor();
const DEFAULT_CHAR_BUDGET = 15000;
const MAX_CHAR_BUDGET = 100000;
const savedDir = process.env.WEB_EXTRACT_SAVE_DIR || join(tmpdir(), 'web-tool-mcp');

server.tool(
  'web_search',
  'Search the web and return concise results with titles, URLs, and search snippets (5 by default). Use web_extract to read a result in detail. The query is passed through to the configured search backend, so operators such as site:domain, filetype:pdf, intitle:word, -term, and quoted phrases may work when supported by the backend.',
  {
    query: z.string().min(1).describe('Search query, including optional backend-supported operators.'),
    limit: z.coerce.number().int().min(1).max(10).default(5).describe('Number of search results (1–10, default 5).'),
  },
  async ({ query, limit }) => {
    const response = await searchEngine.search({ query, numResults: limit });
    const text = response.results.length
      ? response.results.map((item, i) => `## ${i + 1}. ${item.title}\nURL: ${item.url}\nSnippet: ${item.description || '(no snippet)'}`).join('\n\n')
      : 'No search results found.';
    return { content: [{ type: 'text', text: `Search results for: ${query}\nBackend: ${response.engine}\n\n${text}` }] };
  },
);

server.tool(
  'web_extract',
  'Extract readable page content from one or more web page URLs. Returns cleaned Markdown/text directly without LLM summarization. Pages within the character budget (15,000 by default) are returned whole; longer pages return a head-and-tail window and save the complete text to a local file, with a path and read_file instructions for paging through the omitted middle. PDF URLs are accepted as inputs, but PDF text extraction requires a PDF reader dependency not included in this build. Inline images are represented as [IMAGE: alt] and linked image URLs are preserved. If a page fails, times out, or requires JavaScript, login, or clicks, use a browser tool instead.',
  {
    urls: z.array(z.string().url()).min(1).max(5).describe('One to five page URLs to extract.'),
    char_budget: z.coerce.number().int().min(1000).max(MAX_CHAR_BUDGET).default(DEFAULT_CHAR_BUDGET).describe('Maximum inline characters per page (default 15000).'),
    head_chars: z.coerce.number().int().min(500).max(MAX_CHAR_BUDGET).optional().describe('Head window size for oversized pages (defaults to half the character budget).'),
  },
  async ({ urls, char_budget, head_chars }) => {
    const outputs: string[] = [];
    for (const url of urls) {
      if (!validateUrl(url)) {
        outputs.push(`## ${url}\nError: only http and https URLs are supported.`);
        continue;
      }
      try {
        const content = await extractPage(url);
        const title = getTitle(content) || url;
        const body = removeTitle(content);
        if (body.length <= char_budget) {
          outputs.push(`## ${title}\nURL: ${url}\n\n${body}`);
          continue;
        }
        await mkdir(savedDir, { recursive: true });
        const filePath = join(savedDir, `${randomUUID()}.txt`);
        await writeFile(filePath, body, 'utf8');
        const head = Math.min(head_chars ?? Math.floor(char_budget / 2), char_budget - 500);
        const tail = char_budget - head;
        outputs.push(`## ${title}\nURL: ${url}\n\n${body.slice(0, head)}\n\n[... ${body.length - head - tail} characters omitted; full text (${body.length} characters) saved to ${filePath}. Read the file with read_file({ path: "${filePath}", offset: ${head}, limit: ${Math.min(10000, body.length - head - tail)} }) to page through the omitted middle.]\n\n${body.slice(-tail)}`);
      } catch (error) {
        outputs.push(`## ${url}\nExtraction failed: ${error instanceof Error ? error.message : String(error)}. If the page requires JavaScript, login, or interaction, use a browser tool.`);
      }
    }
    return { content: [{ type: 'text', text: outputs.join('\n\n---\n\n') }] };
  },
);

async function extractPage(url: string): Promise<string> {
  const host = new URL(url).hostname.toLowerCase();
  const isWeatherCom = host === 'weather.com' || host.endsWith('.weather.com');
  if (isWeatherCom) {
    const content = await extractor.extractWithBrowser({ url, timeout: 20000, maxContentLength: 2_000_000 });
    const temperatureCount = (content.match(/-?\d+\s?°/g) || []).length;
    if (temperatureCount < 3) {
      throw new Error('weather.com loaded its page shell but did not render forecast rows. Try again later or use a browser tool.');
    }
    return content;
  }
  let response;
  try {
    response = await axios.get(url, {
    responseType: 'arraybuffer', timeout: Number(process.env.DEFAULT_TIMEOUT || 15000),
    maxContentLength: 25 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8' },
    validateStatus: status => status < 400,
    });
  } catch (error) {
    const fallback = await extractor.extractContent({ url, timeout: Number(process.env.DEFAULT_TIMEOUT || 15000), maxContentLength: 2_000_000 });
    if (fallback.trim()) return fallback;
    throw error;
  }
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('pdf') || url.toLowerCase().split('?')[0].endsWith('.pdf')) {
    throw new Error('PDF text extraction is not available in this build; use a PDF reader or browser tool.');
  }
  const html = Buffer.from(response.data).toString('utf8');
  const $ = cheerio.load(html);
  $('script,style,noscript,iframe,svg,canvas,form,nav,header,footer,aside').remove();
  $('img').each((_, el) => {
    const alt = $(el).attr('alt') || '';
    const src = $(el).attr('src') || $(el).attr('data-src');
    $(el).replaceWith(src ? `[IMAGE: ${alt || 'image'}](${new URL(src, url).href})` : `[IMAGE: ${alt || 'image'}]`);
  });
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    const label = $(el).text().trim();
    if (href && label) $(el).replaceWith(`[${label}](${new URL(href, url).href})`);
  });
  const root = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  const title = $('title').first().text().trim();
  let text = root.text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  // Restore useful paragraph and heading boundaries lost by text extraction.
  const blocks: string[] = [];
  root.find('h1,h2,h3,h4,p,li,blockquote,pre').each((_, el) => {
    const node = $(el); const value = node.text().trim();
    if (!value) return;
    const tag = el.tagName.toLowerCase();
    blocks.push(tag[0] === 'h' ? `${'#'.repeat(Number(tag[1]) || 2)} ${value}` : tag === 'li' ? `- ${value}` : value);
  });
  const formattedBlocks = blocks.join('\n\n');
  // Keep complete text from div-based layouts; formatted blocks can omit substantial page content.
  if (formattedBlocks.length >= text.length * 0.8) text = formattedBlocks;
  const content = text || '(No readable page text found.)';
  if (content.replace(/\s/g, '').length < 100) {
    const fallback = await extractor.extractContent({ url, maxContentLength: 2_000_000 });
    if (fallback.replace(/\s/g, '').length > content.replace(/\s/g, '').length) {
      return `${title ? `# ${title}\n\n` : ''}${fallback}`;
    }
  }
  return `${title ? `# ${title}\n\n` : ''}${content}`;
}
function getTitle(markdown: string): string { return markdown.match(/^# (.+)$/m)?.[1] || ''; }
function removeTitle(markdown: string): string { return markdown.replace(/^# .+\n\n?/, '').trim(); }

const transport = new StdioServerTransport();
await server.connect(transport);
process.on('SIGINT', async () => { await Promise.all([extractor.closeAll(), searchEngine.closeAll()]); process.exit(0); });
process.on('SIGTERM', async () => { await Promise.all([extractor.closeAll(), searchEngine.closeAll()]); process.exit(0); });



