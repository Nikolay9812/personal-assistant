// Live-web tools for the chat agent, backed by the Firecrawl SDK.
// Docs: https://docs.firecrawl.dev
//
// Tool names and descriptions are deliberately vendor-neutral: the model reads them, and users
// should never see "Firecrawl" or "Alexandria" in the bot's replies.
import Firecrawl from "@mendable/firecrawl-js";
import { tool } from "ai";
import { z } from "zod";

// Caps on what goes back into the model's context, so one big page or dataset can't blow the
// context window (or the bill).
const MAX_PAGE_CHARS = 12_000;
const MAX_DATA_CHARS = 15_000;
const MAX_SNIPPET_CHARS = 400;

let client: Firecrawl | undefined;

function firecrawl(): Firecrawl {
  if (!client) {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set in the Trigger.dev environment");
    client = new Firecrawl({ apiKey });
  }
  return client;
}

function clip(text: string | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function clipJson(value: unknown, max: number): string {
  return clip(JSON.stringify(value), max);
}

/** Tool failures go back to the model as data so it can retry differently or fall back. */
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Plan/billing errors carry upsell text the model might repeat to users; reduce them to a neutral note.
  if (/paid plan|upgrade|insufficient credits|payment required|\b402\b/i.test(message)) {
    return { ok: false as const, error: "This source is unavailable right now. Use another source or the web." };
  }
  // Blocked-site errors name the vendor and its sales team.
  if (/do not support this site|contact.sales|firecrawl/i.test(message)) {
    return { ok: false as const, error: "This site can't be opened directly. Use searchWeb to find the information." };
  }
  return { ok: false as const, error: clip(message, 300) };
}

const TIMEFRAMES = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" } as const;

export const webTools = {
  searchWeb: tool({
    description:
      "Search the live web and recent news. Returns titles, URLs and short snippets. Use for current " +
      "facts, news, reviews, opinions, laws, prices you can't get from a live data source, or to find " +
      "the right page to read next.",
    inputSchema: z.object({
      query: z.string().min(2).describe("A focused search query, as a person would type it."),
      timeframe: z
        .enum(["any", "day", "week", "month", "year"])
        .default("any")
        .describe("Only return results from this recent period. Use for news and 'latest' questions."),
      country: z
        .string()
        .length(2)
        .optional()
        .describe("ISO 3166-1 alpha-2 country code to localize results, e.g. US, GB, DE."),
      limit: z.number().int().min(1).max(8).default(5),
    }),
    execute: async ({ query, timeframe, country, limit }) => {
      try {
        const data = await firecrawl().search(query, {
          sources: ["web", "news"],
          limit,
          ...(timeframe !== "any" && { tbs: TIMEFRAMES[timeframe] }),
          ...(country && { country: country.toUpperCase() }),
        });
        const toResult = (r: Record<string, unknown>) => ({
          title: r.title,
          url: r.url,
          date: r.date,
          snippet: clip((r.description ?? r.snippet) as string | undefined, MAX_SNIPPET_CHARS),
        });
        return {
          ok: true as const,
          web: (data.web ?? []).map((r) => toResult(r as Record<string, unknown>)),
          news: (data.news ?? []).map((r) => toResult(r as Record<string, unknown>)),
        };
      } catch (error) {
        return failure(error);
      }
    },
  }),

  readWebPage: tool({
    description:
      "Open a web page and read its main content as text. Use when the user shares a link, or to read " +
      "a promising page found with searchWeb (pricing pages, articles, listings, statute text, docs).",
    inputSchema: z.object({
      url: z.string().url().describe("The full http(s) URL of the page."),
    }),
    execute: async ({ url }) => {
      try {
        const doc = await firecrawl().scrape(url, { formats: ["markdown"], onlyMainContent: true });
        return {
          ok: true as const,
          url: doc.metadata?.sourceURL ?? url,
          title: doc.metadata?.title,
          content: clip(doc.markdown, MAX_PAGE_CHARS),
        };
      } catch (error) {
        return failure(error);
      }
    },
  }),

  findLiveDataSources: tool({
    description:
      "Find ready-made live data sources (structured, real-time data from specific sites and APIs) for a " +
      "need. Covers things like: product prices and stock at major retailers, flights and hotels, " +
      "restaurant tables, fitness classes, campsites, rentals and homes for sale, flood zones, job " +
      "postings, ticket prices, stocks (insider trades, options, analyst ratings, SEC financials), " +
      "prediction markets, crypto yields, startup funding rounds, company and contact data, local " +
      "businesses and their reviews, competitor ads, app store ratings, software reviews, used car " +
      "values and recalls, sneaker and vinyl resale prices, streaming catalogs, trending AI models, " +
      "fantasy sports projections, social video trends, earthquakes. Returns candidate sources with " +
      "their required inputs and a cost; then call getLiveData with one of them.",
    inputSchema: z.object({
      need: z
        .string()
        .min(3)
        .describe(
          "The data needed, in plain words, including the site if the user named one, e.g. " +
            "'open restaurant reservations tonight in Brooklyn' or 'StockX resale price Jordan 4 size 10'."
        ),
      limit: z.number().int().min(1).max(8).default(5),
    }),
    execute: async ({ need, limit }) => {
      try {
        const data = await firecrawl().search(need, {
          sources: ["alexandria"],
          limit,
          toolDetail: "full",
        });
        const sources = (data.tools ?? []).map((t) => ({
          provider: t.provider,
          capability: t.capability,
          description: clip(t.description, 300),
          cost: t.creditsCost,
          inputs: (t.options ?? []).map((o) => ({
            name: o.name,
            type: o.type,
            required: o.required ?? false,
            about: clip(o.about as string | undefined, 200),
            ...(o.oneOf !== undefined && { oneOf: o.oneOf }),
            ...(o.default !== undefined && { default: o.default }),
          })),
          requiresOneOf: t.requiresOneOf,
          exampleInput: t.example?.request,
        }));
        return {
          ok: true as const,
          sources,
          hint: sources.length
            ? "Pick the best match and call getLiveData with its provider, capability and inputs. If every " +
              "match needs an ID you don't have (sku, asin, item number, url), call findLiveDataSources again " +
              "for a search by name first, e.g. 'search Newegg products by name' or 'Best Buy product search'."
            : "No live data source matched. Use searchWeb and readWebPage instead.",
        };
      } catch (error) {
        return failure(error);
      }
    },
  }),

  getLiveData: tool({
    description:
      "Fetch structured live data from a source returned by findLiveDataSources. Pass its provider and " +
      "capability exactly as returned, and inputs that match its input list. Input names are literal, flat " +
      "keys: an input named 'parameters[tickers]' is passed as {\"parameters[tickers]\": \"NVDA\"}, never " +
      "nested. If a call fails with invalid input, fix the inputs using the error message once; if a source " +
      "is unavailable, don't retry it.",
    inputSchema: z.object({
      provider: z.string().describe("The provider id from findLiveDataSources, e.g. 'newegg-com'."),
      capability: z.string().describe("The capability id from findLiveDataSources, e.g. 'products/search'."),
      inputs: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Input values keyed by input name."),
    }),
    execute: async ({ provider, capability, inputs }) => {
      try {
        const res = await firecrawl().scrape({ alexandria: { provider, capability, options: inputs } });
        const result = res.alexandria[0];
        if (!result) return failure("The data source returned nothing.");
        if (result.error) return failure(`${result.error.code}: ${result.error.message}`);
        return {
          ok: true as const,
          provider,
          capability,
          records: result.records,
          recordedAt: result.recordedAt,
          data: clipJson(result.data, MAX_DATA_CHARS),
        };
      } catch (error) {
        return failure(error);
      }
    },
  }),
};
