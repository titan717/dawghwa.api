import type { Provider } from "@/lib/providers/provider";

/** Public JSON description of a provider (upstream SourceInfo fields first). */
export function describeProvider(p: Provider, verbose = false) {
  const d = p.descriptor;
  const circuit = p.circuit();
  return {
    id: d.id,
    name: d.name,
    baseUrl: d.baseUrl,
    description: d.description,
    clientOnly: p.capabilities.clientOnly,
    type: d.type,
    status: p.isDisabled ? "disabled" : d.status,
    ...(d.statusNote ? { statusNote: d.statusNote } : {}),
    priority: d.priority,
    capabilities: p.capabilities,
    ...(verbose
      ? {
          aliases: d.aliases,
          domains: d.domains,
          rateLimit: { rps: d.rateLimit.rps, burst: d.rateLimit.burst, maxConcurrent: d.rateLimit.maxConcurrent },
          circuit,
          metrics: p.metrics,
        }
      : { circuit: circuit.state }),
  };
}
