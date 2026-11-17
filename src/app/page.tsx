"use client";

import { useEffect, useState } from "react";
import { SHUTDOWN_SOURCE_IDS } from "@/lib/shutdown-sources";

interface Source {
  id: string;
  name: string;
  baseUrl: string;
  description?: string;
  clientOnly?: boolean;
}

interface FrontpageSection {
  id: string;
  title: string;
  type: string;
  supportsTimeFilter: boolean;
  availableTimeFilters?: number[];
}

interface FrontpageInfo {
  sourceId: string;
  sourceName: string;
  availableSections: FrontpageSection[];
}

interface SourceHealth {
  status: "healthy" | "cloudflare" | "timeout" | "error";
  message: string;
  responseTime?: number;
  lastChecked: string;
}

interface EndpointProps {
  method: string;
  path: string;
  description: string;
  request?: string;
  response: string;
}

const endpoints: EndpointProps[] = [
  {
    method: "GET",
    path: "/api/catalog",
    description:
      "Browse series metadata from AniList (default), MangaDex or MangaUpdates. Filters: q, genre, excludeGenre, tag, status, format, year, sort, nsfw, page, limit",
    request: `GET /api/catalog?genre=Action&format=manhwa&status=ongoing&sort=popularity&limit=20`,
    response: `{
  "provider": "anilist",
  "items": [
    { "ref": "anilist:105398", "title": "Solo Leveling", "format": "manhwa",
      "status": "completed", "genres": ["Action", "Adventure", "Fantasy"], "score": 84 }
  ],
  "pageInfo": { "page": 1, "limit": 20, "hasNextPage": true },
  "attribution": { "name": "AniList", "url": "https://anilist.co" }
}`,
  },
  {
    method: "GET",
    path: "/api/titles/{ref}/sources",
    description:
      "Which working sources carry a series, ranked best first with match confidence. Add stream=1 for NDJSON. Blocked or failing sources are skipped and listed.",
    request: `GET /api/titles/anilist:105398/sources?sources=asurascan,mangadex`,
    response: `{
  "sources": [
    { "sourceId": "asurascan", "available": true, "state": "working",
      "best": { "title": "Solo Leveling", "url": "https://asurascans.com/comics/...",
                "latestChapter": 200, "confidence": "exact" },
      "candidates": [{ "title": "Solo Leveling: Ragnarok", "confidence": "possible" }] }
  ],
  "skipped": [],
  "summary": { "availableSources": 2, "ranking": ["mangadex", "asurascan"] }
}`,
  },
  {
    method: "GET",
    path: "/api/titles/{ref}/chapters",
    description: "Chapter list for a series from the source the user picked (404 with candidates if the source has no confident match)",
    request: `GET /api/titles/anilist:105398/chapters?source=asurascan&order=desc`,
    response: `{
  "sourceId": "asurascan",
  "match": { "title": "Solo Leveling", "confidence": "exact" },
  "chapters": [{ "number": 200, "title": "Chapter 200", "url": "https://..." }],
  "totalChapters": 201
}`,
  },
  {
    method: "GET",
    path: "/api/sources",
    description: "Retrieve list of available sources",
    response: `{
  "sources": [
    {
      "id": "mangadex",
      "name": "MangaPark",
      "baseUrl": "https://mangadex.org",
      "description": "MangaDex - https://mangadex.org",
      "status": "active"
    }
  ]
}`,
  },
  {
    method: "POST",
    path: "/api/search",
    description: "Search for manga across one or all sources",
    request: `{
  "query": "solo leveling",
  "source": "mangadex"  // or "all" for all sources
}`,
    response: `{
  "results": [
    {
      "id": "343921",
      "title": "Solo Leveling",
      "url": "https://mangadex.org/title/...",
      "coverImage": "https://...",
      "latestChapter": 179,
      "lastUpdated": "2 days ago"
    }
  ],
  "source": "MangaPark"
}`,
  },
  {
    method: "POST",
    path: "/api/chapters",
    description: "Get chapter list for a manga",
    request: `{
  "url": "https://mangadex.org/title/37f5cce0-8070-4ada-96e5-fa24b1bd4ff9",
  "source": "mangadex",  // optional
  "offset": 0, "limit": 100  // optional pagination
}`,
    response: `{
  "chapters": [
    {
      "id": "1",
      "number": 1,
      "title": "Chapter 1",
      "url": "https://..."
    }
  ],
  "source": "MangaPark",
  "totalChapters": 179
}`,
  },
  {
    method: "POST",
    path: "/api/pages",
    description: "Chapter page image URLs (only sources with a documented page API, e.g. MangaDex)",
    request: `{
  "source": "mangadex",
  "chapterId": "<chapter uuid>",
  "dataSaver": false        // optional
}`,
    response: `{
  "pages": [{ "index": 0, "url": "https://.../data/<hash>/1.png" }],
  "totalPages": 18,
  "source": "MangaDex",
  "sourceId": "mangadex"
}`,
  },
  {
    method: "POST",
    path: "/api/manga",
    description: "Basic metadata (title, source id) for a manga URL",
    request: `{
  "url": "https://mangadex.org/title/<uuid>"
}`,
    response: `{
  "manga": { "title": "...", "id": "...", "url": "..." },
  "source": "MangaDex",
  "sourceId": "mangadex"
}`,
  },
  {
    method: "GET",
    path: "/api/health",
    description: "Check health status of all sources (cached for 5 minutes)",
    response: `{
  "sources": {
    "mangadex": {
      "status": "healthy",
      "message": "Source is operational",
      "responseTime": 1234,
      "lastChecked": "2025-01-08T..."
    }
  }
}`,
  },
  {
    method: "GET",
    path: "/api/frontpage",
    description: "Get list of sources with frontpage support and their available sections",
    response: `{
  "sources": [
    {
      "sourceId": "comix",
      "sourceName": "Comix",
      "availableSections": [
        {
          "id": "trending",
          "title": "Most Recent Popular",
          "type": "trending",
          "supportsTimeFilter": true,
          "availableTimeFilters": [1, 7, 30, 90, 180, 365]
        }
      ]
    }
  ],
  "sourceIds": ["comix"]
}`,
  },
  {
    method: "POST",
    path: "/api/frontpage",
    description: "Fetch frontpage section data from a source",
    request: `{
  "source": "comix",
  "section": "trending",  // trending, most_followed, latest_hot, latest_new, recently_added, completed
  "page": 1,              // optional, default: 1
  "limit": 30,            // optional, default: 30
  "days": 7               // optional, for time-filtered sections (1, 7, 30, 90, 180, 365)
}`,
    response: `{
  "source": "comix",
  "sourceName": "Comix",
  "section": {
    "id": "trending",
    "title": "Most Recent Popular",
    "type": "trending",
    "items": [
      {
        "id": "ylgn",
        "title": "Evolution Begins With A Big Tree",
        "url": "https://comix.to/title/ylgn-evolution-begins-with-a-big-tree",
        "coverImage": "https://...",
        "latestChapter": 481,
        "rating": 8.2,
        "followers": "2773"
      }
    ],
    "supportsPagination": false,
    "supportsTimeFilter": true
  },
  "fetchedAt": 1704700000000
}`,
  },
];

function MethodBadge({ method }: { method: string }) {
  const styles = {
    GET: "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
    POST: "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
  };

  return (
    <span
      className={`px-2.5 py-1 text-xs font-medium rounded-md ${
        styles[method as keyof typeof styles] || styles.GET
      }`}
    >
      {method}
    </span>
  );
}

function EndpointCard({ endpoint }: { endpoint: EndpointProps }) {
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 md:p-6 bg-white dark:bg-zinc-900/30">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <MethodBadge method={endpoint.method} />
        <code className="text-base md:text-lg font-mono text-zinc-900 dark:text-zinc-100 break-all">
          {endpoint.path}
        </code>
      </div>

      <p className="text-zinc-600 dark:text-zinc-400 mb-6 text-sm md:text-base">
        {endpoint.description}
      </p>

      {endpoint.request && (
        <div className="mb-4">
          <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-2">
            REQUEST BODY
          </h4>
          <div className="bg-zinc-900 dark:bg-zinc-800 rounded-lg p-4 overflow-x-auto">
            <pre className="text-xs sm:text-sm">
              <code className="text-zinc-100">{endpoint.request}</code>
            </pre>
          </div>
        </div>
      )}

      <div>
        <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-2">
          RESPONSE
        </h4>
        <div className="bg-zinc-900 dark:bg-zinc-800 rounded-lg p-4 overflow-x-auto">
          <pre className="text-xs sm:text-sm">
            <code className="text-zinc-100">{endpoint.response}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [sources, setSources] = useState<Source[]>([]);
  const [health, setHealth] = useState<Record<string, SourceHealth>>({});
  const [frontpageSources, setFrontpageSources] = useState<FrontpageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [healthLoading, setHealthLoading] = useState(true);
  const [frontpageLoading, setFrontpageLoading] = useState(true);

  useEffect(() => {
    // Fetch sources
    fetch("/api/sources")
      .then((res) => res.json())
      .then((data) => {
        const sortedSources = (data.sources || []).sort(
          (a: Source, b: Source) => a.name.localeCompare(b.name)
        );
        setSources(sortedSources);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load sources:", err);
        setLoading(false);
      });

    // Fetch health status
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        setHealth(data.sources || {});
        setHealthLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load health:", err);
        setHealthLoading(false);
      });

    // Fetch frontpage sources
    fetch("/api/frontpage")
      .then((res) => res.json())
      .then((data) => {
        setFrontpageSources(data.sources || []);
        setFrontpageLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load frontpage sources:", err);
        setFrontpageLoading(false);
      });
  }, []);

  const getStatusColor = (status?: string) => {
    if (status === "shutdown") {
      return "bg-zinc-500";
    }
    switch (status) {
      case "healthy":
        return "bg-emerald-500";
      case "cloudflare":
        return "bg-yellow-500";
      case "timeout":
        return "bg-orange-500";
      case "error":
        return "bg-red-500";
      default:
        return "bg-zinc-600";
    }
  };

  const getStatusTextColor = (status?: string) => {
    if (status === "shutdown") {
      return "text-zinc-400";
    }
    switch (status) {
      case "healthy":
        return "text-emerald-400";
      case "cloudflare":
        return "text-yellow-400";
      case "timeout":
        return "text-orange-400";
      case "error":
        return "text-red-400";
      default:
        return "text-zinc-500";
    }
  };

  const getStatusLabel = (status?: string) => {
    if (status === "shutdown") {
      return "Shutdown";
    }
    switch (status) {
      case "healthy":
        return "Operational";
      case "cloudflare":
        return "Cloudflare Protected";
      case "timeout":
        return "Slow/Timeout";
      case "error":
        return "Error";
      default:
        return "Checking...";
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12 md:py-16">
        <header className="mb-12 md:mb-20">
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-zinc-900 dark:text-zinc-100 mb-4 md:mb-6 tracking-tight">
            Dawghwa API
          </h1>
          <p className="text-lg md:text-xl text-zinc-600 dark:text-zinc-400 leading-relaxed max-w-2xl">
            RESTful API for manga and comic metadata. Search across multiple
            sources, retrieve chapter listings, and monitor source health.
          </p>
        </header>

        <section className="mb-12 md:mb-16">
          <h2 className="text-xl md:text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6 md:mb-8">
            Endpoints
          </h2>
          <div className="space-y-4 md:space-y-6">
            {endpoints.map((endpoint, index) => (
              <EndpointCard key={index} endpoint={endpoint} />
            ))}
          </div>
        </section>

        <section className="mb-12 md:mb-16">
          <h2 className="text-xl md:text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6 md:mb-8">
            Frontpage Support
          </h2>
          <p className="text-zinc-600 dark:text-zinc-400 mb-6 text-sm md:text-base">
            Some sources support fetching frontpage data like trending, latest updates, and more.
          </p>

          {frontpageLoading ? (
            <div className="flex items-center justify-center py-10">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-800 border-t-zinc-900 dark:border-t-zinc-100"></div>
            </div>
          ) : frontpageSources.length === 0 ? (
            <p className="text-zinc-500 dark:text-zinc-500 text-sm">No sources with frontpage support available.</p>
          ) : (
            <div className="space-y-4">
              {frontpageSources.map((fp) => (
                <div
                  key={fp.sourceId}
                  className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 md:p-6 bg-white dark:bg-zinc-900/30"
                >
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
                    {fp.sourceName}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {fp.availableSections.map((section) => (
                      <span
                        key={section.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      >
                        {section.title}
                        {section.supportsTimeFilter && (
                          <span className="text-zinc-400 dark:text-zinc-500" title="Supports time filtering">
                            ⏱
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mb-12 md:mb-16">
          <h2 className="text-xl md:text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6 md:mb-8">
            Available Sources
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 dark:border-zinc-800 border-t-zinc-900 dark:border-t-zinc-100"></div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {sources.map((source) => {
                const effectiveStatus = SHUTDOWN_SOURCE_IDS.has(source.id)
                  ? "shutdown"
                  : health[source.id]?.status;
                const sourceHealth = health[source.id];
                const statusColor = getStatusColor(effectiveStatus);
                const statusLabel = getStatusLabel(effectiveStatus);

                return (
                  <div
                    key={source.id}
                    className="border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 md:p-6 bg-white dark:bg-zinc-900/30"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {source.name}
                      </h3>
                      <div className="flex items-center gap-2">
                        {healthLoading ? (
                          <div className="h-2 w-2 animate-pulse rounded-full bg-zinc-400 dark:bg-zinc-600"></div>
                        ) : (
                          <div
                            className={`h-2 w-2 rounded-full ${statusColor}`}
                            title={sourceHealth?.message || "Unknown"}
                          ></div>
                        )}
                      </div>
                    </div>

                    <a
                      href={source.baseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-xs text-zinc-500 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-400 transition-colors break-all mb-3"
                    >
                      {source.baseUrl}
                    </a>

                    {sourceHealth && (
                      <div className="flex items-center justify-between text-xs border-t border-zinc-200 dark:border-zinc-800 pt-3">
                        <span
                          className={getStatusTextColor(effectiveStatus)}
                        >
                          {statusLabel}
                        </span>
                        {sourceHealth.responseTime && (
                          <span className="text-zinc-500 dark:text-zinc-500">
                            {sourceHealth.responseTime}ms
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
