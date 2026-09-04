import https from "https";
import http from "http";

export const webTools = [
  {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo. Returns search results with titles, URLs, and snippets. Use this to find documentation, solutions to errors, or current information.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        max_results: {
          type: "number",
          description: "Maximum results to return (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch content from a URL. Returns the text content of the page. Useful for reading documentation, APIs, or web pages.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch",
        },
        max_length: {
          type: "number",
          description: "Maximum characters to return (default: 50000)",
        },
      },
      required: ["url"],
    },
  },
];

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const lib = isHttps ? https : http;
    const parsedUrl = new URL(url);

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": options.acceptType || "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive",
        ...options.headers,
      },
    };

    const request = lib.request(reqOptions, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let redirectUrl = response.headers.location;
        if (!redirectUrl.startsWith("http")) {
          redirectUrl = new URL(redirectUrl, url).toString();
        }
        response.resume();
        return httpRequest(redirectUrl, options).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (options.binary) {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: response.headers["content-type"] || "application/octet-stream",
          });
        } else {
          resolve(Buffer.concat(chunks).toString("utf-8"));
        }
      });
      response.on("error", reject);
    });

    request.on("error", reject);
    request.setTimeout(options.timeout || 30000, () => {
      request.destroy();
      reject(new Error("Request timeout"));
    });

    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function stripHtml(html) {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

async function duckduckgoSearch(query, maxResults = 10) {
  const results = [];

  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    const html = await httpRequest(url, { timeout: 20000 });

    const resultRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result|$)/gi;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const block = match[1];

      const urlMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>/i) ||
                       block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"/i) ||
                       block.match(/<a[^>]*class="[^"]*result__url[^"]*"[^>]*href="([^"]+)"/i);

      if (!urlMatch) continue;

      let resultUrl = urlMatch[1];

      if (resultUrl.includes("uddg=")) {
        const uddgMatch = resultUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          resultUrl = decodeURIComponent(uddgMatch[1]);
        }
      }

      if (resultUrl.includes("duckduckgo.com")) continue;

      const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([^<]+)</i) ||
                         block.match(/<h2[^>]*class="[^"]*result__title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)</i);
      const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : "No title";

      const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
                          block.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]).slice(0, 200) : "";

      if (title && resultUrl && !resultUrl.includes("duckduckgo")) {
        results.push({
          title: title,
          url: resultUrl,
          snippet: snippet,
        });
      }
    }

    if (results.length === 0) {
      const simpleRegex = /<a[^>]+href="[^"]*uddg=([^"&]+)[^"]*"[^>]*>([^<]+)<\/a>/gi;
      const seen = new Set();

      while ((match = simpleRegex.exec(html)) !== null && results.length < maxResults) {
        const resultUrl = decodeURIComponent(match[1]);
        const title = decodeHtmlEntities(match[2].trim());

        if (seen.has(resultUrl)) continue;
        if (resultUrl.includes("duckduckgo.com")) continue;
        if (title.length < 3) continue;

        seen.add(resultUrl);
        results.push({
          title: title,
          url: resultUrl,
          snippet: "",
        });
      }
    }

  } catch (error) {
    throw new Error(`Search failed: ${error.message}`);
  }

  return results;
}

export async function handleWebTool(name, args) {
  switch (name) {
    case "web_search": {
      try {
        const results = await duckduckgoSearch(args.query, args.max_results || 10);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for: ${args.query}` }],
          };
        }

        let output = `Search results for: ${args.query}\n${"─".repeat(50)}\n\n`;
        results.forEach((r, i) => {
          output += `${i + 1}. ${r.title}\n`;
          output += `   ${r.url}\n`;
          if (r.snippet) {
            output += `   ${r.snippet}\n`;
          }
          output += "\n";
        });

        return {
          content: [{ type: "text", text: output.trim() }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Search error: ${error.message}` }],
          isError: true,
        };
      }
    }

    case "web_fetch": {
      try {
        const html = await httpRequest(args.url, { timeout: 30000 });
        const text = stripHtml(html);
        const maxLength = args.max_length || 50000;

        const truncated = text.length > maxLength
          ? text.slice(0, maxLength) + "\n\n... (truncated)"
          : text;

        return {
          content: [{ type: "text", text: truncated }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Fetch error: ${error.message}` }],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown web tool: ${name}`);
  }
}
