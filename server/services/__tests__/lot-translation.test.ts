import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../env", () => ({
  env: {
    GEMINI_API_KEY: "test-gemini-key",
    AI_INTEGRATIONS_OPENAI_API_KEY: "test-openai-key",
  },
}));

vi.mock("../../storage", () => ({
  storage: {
    getAiModelSetting: vi.fn(),
  },
}));

const generateContentMock = vi.fn();
vi.mock("@google/generative-ai", () => {
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return { generateContent: generateContentMock };
    }
  }
  return {
    GoogleGenerativeAI,
    SchemaType: { OBJECT: "object", STRING: "string" },
  };
});

const openaiCreateMock = vi.fn();
vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: openaiCreateMock } };
  }
  return { default: OpenAI };
});

import { storage } from "../../storage";
import { translateLotDescription } from "../lot-translation";

const getAiModelSetting = storage.getAiModelSetting as unknown as ReturnType<typeof vi.fn>;

describe("translateLotDescription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the translated string from Gemini and uses the configured model", async () => {
    getAiModelSetting.mockResolvedValue({ provider: "gemini", modelId: "gemini-2.5-flash" });
    generateContentMock.mockResolvedValue({
      response: { text: () => JSON.stringify({ translation: "Plumbing" }) },
    });

    const result = await translateLotDescription("Plomberie", "LOT8");

    expect(result.translation).toBe("Plumbing");
    expect(result.provider).toBe("gemini");
    expect(result.modelId).toBe("gemini-2.5-flash");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("uses OpenAI when configured", async () => {
    getAiModelSetting.mockResolvedValue({ provider: "openai", modelId: "gpt-4o-mini" });
    openaiCreateMock.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ translation: "Exterior Joinery" }) } }],
    });

    const result = await translateLotDescription("Menuiseries extérieures");

    expect(result.translation).toBe("Exterior Joinery");
    expect(result.provider).toBe("openai");
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to default model when no setting is configured", async () => {
    getAiModelSetting.mockResolvedValue(undefined);
    generateContentMock.mockResolvedValue({
      response: { text: () => JSON.stringify({ translation: "Structural Works" }) },
    });

    const result = await translateLotDescription("Gros œuvre");

    expect(result.translation).toBe("Structural Works");
    expect(result.provider).toBe("gemini");
    expect(result.modelId).toBe("gemini-2.5-flash");
  });

  it("rejects empty input", async () => {
    await expect(translateLotDescription("   ")).rejects.toThrow(/required/i);
  });
});
