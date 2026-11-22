import { getAllScrapers } from "@/lib/scrapers";
import { getAllFrontpages } from "@/lib/frontpages";
import { getConfig } from "@/lib/core/config";
import { ADAPTER_DOMAINS } from "./manifest.generated";
import { Provider } from "./provider";
import { DEFAULT_PRIORITIES, EXPERIMENTAL_SOURCE_IDS, RATE_LIMITS, SOURCE_ALIASES, STATUS_NOTES, statusFor } from "./status";

/**
 * Central source registry. Adapters stay independent modules; the registry
 * wraps each one in a Provider (isolation, limits, breaker, metrics) and is
 * the single place that resolves ids, aliases, names and URLs to providers.
 */
export class ProviderRegistry {
  private readonly providers: Provider[];
  private readonly byKey = new Map<string, Provider>();

  constructor(providers: Provider[]) {
    this.providers = [...providers].sort(
      (a, b) => b.descriptor.priority - a.descriptor.priority || a.name.localeCompare(b.name),
    );
    for (const p of this.providers) {
      for (const key of [p.id, p.name.toLowerCase(), ...p.descriptor.aliases]) {
        if (!this.byKey.has(key)) this.byKey.set(key, p);
      }
    }
  }

  /** All providers in priority order (including shut down ones, for listing). */
  all(): Provider[] {
    return this.providers;
  }

  /** Providers that may be called (excludes shut down / disabled). */
  operational(): Provider[] {
    return this.providers.filter((p) => p.operational);
  }

  get(idOrName: string): Provider | undefined {
    return this.byKey.get(idOrName.trim().toLowerCase());
  }

  /** Exact domain match (no substring matching, unlike upstream). */
  forUrl(url: URL): Provider | undefined {
    return this.providers.find((p) => p.ownsUrl(url));
  }

  ids(): string[] {
    return this.providers.map((p) => p.id);
  }
}

let registry: ProviderRegistry | null = null;

/** True when a source may be registered on this server (experimental ones need EXPERIMENTAL_PROVIDERS). */
export function isSourceEnabled(id: string, experimentalEnabled: readonly string[] = getConfig().providers.experimental): boolean {
  if (!EXPERIMENTAL_SOURCE_IDS.has(id)) return true;
  return experimentalEnabled.some((s) => s.toLowerCase() === id);
}

export function buildRegistry(): ProviderRegistry {
  const cfg = getConfig().providers;
  const disabled = new Set(cfg.disabled.map((s) => s.toLowerCase()));
  const configuredPriority = new Map(cfg.priority.map((id, i) => [id.toLowerCase(), 1_000 - i]));
  const frontpages = new Map(getAllFrontpages().map((f) => [f.getSourceId(), f]));

  const providers = getAllScrapers()
    .filter((scraper) => isSourceEnabled(scraper.getId(), cfg.experimental))
    .map((scraper) => {
      const id = scraper.getId();
      const name = scraper.getName();
      const baseUrl = scraper.getBaseUrl();
      const domains = ADAPTER_DOMAINS[name] ?? [new URL(baseUrl).hostname.replace(/^www\./, "")];
      return new Provider(
        {
          id,
          name,
          baseUrl,
          description: scraper.getDescription(),
          type: scraper.getType(),
          status: statusFor(id),
          statusNote: STATUS_NOTES[id],
          priority: configuredPriority.get(id) ?? DEFAULT_PRIORITIES[id] ?? 50,
          aliases: SOURCE_ALIASES[id] ?? [],
          domains,
          rateLimit: {
            rps: cfg.defaultRps,
            burst: cfg.defaultBurst,
            maxConcurrent: cfg.defaultMaxConcurrent,
            maxQueue: 200,
            ...RATE_LIMITS[id],
          },
        },
        scraper,
        frontpages.get(id),
        disabled.has(id),
      );
    });
  return new ProviderRegistry(providers);
}

export function getRegistry(): ProviderRegistry {
  if (!registry) registry = buildRegistry();
  return registry;
}

/** Test helper. */
export function resetRegistry(): void {
  registry = null;
}
