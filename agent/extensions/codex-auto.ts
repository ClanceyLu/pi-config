import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER = "openai-codex";
const UUIDCX_PROVIDER = "uuidcx";
const UUIDCX_AUTO_PROVIDERS = ["uuidcx", "uuidcx-grok"];

type RoutedModel = { id: string; provider: string; api?: string };

/** Prefer Sol variants, then the newest GPT family available for the provider. */
export function rankAutoModels<T extends RoutedModel>(models: readonly T[], provider: string): T[] {
  const version = (id: string): number[] => {
    const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
    return match ? [Number(match[1]), Number(match[2] ?? 0)] : [0, 0];
  };
  return models.filter((model) => model.provider === provider && model.id !== "auto").sort((a, b) => {
    const sol = Number(/-sol$/.test(b.id)) - Number(/-sol$/.test(a.id));
    if (sol) return sol;
    const av = version(a.id), bv = version(b.id);
    return bv[0] - av[0] || bv[1] - av[1] || a.id.localeCompare(b.id);
  });
}

function registerAuto(
  pi: ExtensionAPI,
  provider: string,
  name: string,
  error: string,
  candidateProviders = [provider],
) {
  pi.registerVirtualModel({
    provider,
    id: "auto",
    name,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    async route(request, ctx) {
      const available = ctx.modelRegistry.getAvailable()
        .filter((model) => candidateProviders.includes(model.provider) && model.api !== "pi-virtual");
      const sticky = request.reason === "retry" ? request.failed ?? request.previous : request.previous;
      if (request.reason !== "user" && sticky && candidateProviders.includes(sticky.model.provider)) {
        const model = available.find((item) => item.provider === sticky.model.provider && item.id === sticky.model.id);
        if (model) return { model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
      }
      const model = candidateProviders
        .flatMap((candidateProvider) => rankAutoModels(available, candidateProvider))
        .sort((a, b) => {
          const aGrok = Number(a.provider === "uuidcx-grok");
          const bGrok = Number(b.provider === "uuidcx-grok");
          return aGrok - bGrok;
        })[0];
      if (!model) throw new Error(error);
      return { model, thinkingLevel: request.thinkingLevel };
    },
  });
}

export function rankCodexModels<T extends RoutedModel>(models: readonly T[]): T[] {
  return rankAutoModels(models, CODEX_PROVIDER);
}

export default function (pi: ExtensionAPI) {
  // Keep the historical Codex registration last for extensions that inspect the first definition.
  registerAuto(
    pi,
    UUIDCX_PROVIDER,
    "UUIDCX Auto (latest Sol, Grok fallback)",
    "没有可用的 UUIDCX 模型，请检查 UUIDCX_API_KEY、UUIDCX_GROK_KEY 和模型配置。",
    UUIDCX_AUTO_PROVIDERS,
  );
  registerAuto(pi, CODEX_PROVIDER, "Codex Auto (latest Sol)", "没有可用的 Codex 模型，请通过 /login 登录 OpenAI Codex 并检查模型配置。");
}
