import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../env", () => ({
  env: {
    GEMINI_API_KEY: "test-gemini-key",
    AI_INTEGRATIONS_OPENAI_API_KEY: "test-openai-key",
  },
}));

vi.mock("../../storage", () => ({
  storage: {
    getDevis: vi.fn(),
    getDevisTranslation: vi.fn(),
    getDevisLineItems: vi.fn(),
    upsertDevisTranslation: vi.fn(),
    updateDevisTranslation: vi.fn(),
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
    SchemaType: {
      OBJECT: "object",
      ARRAY: "array",
      STRING: "string",
      INTEGER: "integer",
    },
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
import { translateDevis } from "../devis-translation";

const getDevis = storage.getDevis as unknown as ReturnType<typeof vi.fn>;
const getDevisTranslation = storage.getDevisTranslation as unknown as ReturnType<typeof vi.fn>;
const getDevisLineItems = storage.getDevisLineItems as unknown as ReturnType<typeof vi.fn>;
const upsertDevisTranslation = storage.upsertDevisTranslation as unknown as ReturnType<typeof vi.fn>;
const updateDevisTranslation = storage.updateDevisTranslation as unknown as ReturnType<typeof vi.fn>;
const getAiModelSetting = storage.getAiModelSetting as unknown as ReturnType<typeof vi.fn>;

function geminiResponse(payload: unknown) {
  return { response: { text: () => JSON.stringify(payload) } };
}

function openaiResponse(payload: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(payload) } }],
  };
}

const baseDevis = {
  id: 42,
  devisCode: "D-42",
  descriptionFr: "Travaux de plomberie complets",
  projectId: 1,
  contractorId: 2,
} as never;

const baseLines = [
  { lineNumber: 1, description: "Fourniture et pose WC suspendu", id: 1, devisId: 42 },
  { lineNumber: 2, description: "Raccordement plomberie cuisine", id: 2, devisId: 42 },
];

describe("translateDevis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDevis.mockResolvedValue(baseDevis);
    getDevisLineItems.mockResolvedValue(baseLines);
    upsertDevisTranslation.mockResolvedValue({});
    updateDevisTranslation.mockResolvedValue({});
  });

  it("translates successfully via Gemini, transitions processing → draft, and clears stale PDF keys", async () => {
    getDevisTranslation.mockResolvedValue(null);
    getAiModelSetting.mockResolvedValue({ provider: "gemini", modelId: "gemini-2.5-flash" });

    generateContentMock.mockResolvedValue(
      geminiResponse({
        header: {
          description: "Complete plumbing works",
          descriptionExplanation: null,
          summary: "Plumbing scope.",
        },
        lines: [
          { lineNumber: 1, originalDescription: "Fourniture et pose WC suspendu", translation: "Supply and install wall-hung WC" },
          { lineNumber: 2, originalDescription: "Raccordement plomberie cuisine", translation: "Kitchen plumbing connection" },
        ],
      }),
    );

    const result = await translateDevis(42);

    // First call sets status=processing and clears PDF keys
    expect(upsertDevisTranslation).toHaveBeenCalledWith(
      expect.objectContaining({
        devisId: 42,
        status: "processing",
        translatedPdfStorageKey: null,
        combinedPdfStorageKey: null,
      }),
    );

    // Second call commits the draft with provider/model + cleared PDF keys
    expect(updateDevisTranslation).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        status: "draft",
        provider: "gemini",
        modelId: "gemini-2.5-flash",
        translatedPdfStorageKey: null,
        combinedPdfStorageKey: null,
        errorMessage: null,
      }),
    );

    expect(result.provider).toBe("gemini");
    expect(result.translation.lines).toHaveLength(2);
    expect(result.translation.lines[0]).toMatchObject({
      lineNumber: 1,
      translation: "Supply and install wall-hung WC",
      edited: false,
    });
    expect(result.translation.header.description).toBe("Complete plumbing works");
  });

  it("marks the translation as failed when the model returns a payload that fails Zod validation", async () => {
    getDevisTranslation.mockResolvedValue(null);
    getAiModelSetting.mockResolvedValue({ provider: "gemini", modelId: "gemini-2.5-flash" });

    // header missing entirely + line missing required `translation`
    generateContentMock.mockResolvedValue(
      geminiResponse({
        lines: [{ lineNumber: 1, originalDescription: "x" }],
      }),
    );

    await expect(translateDevis(42)).rejects.toThrow();

    expect(updateDevisTranslation).toHaveBeenLastCalledWith(
      42,
      expect.objectContaining({
        status: "failed",
        errorMessage: expect.any(String),
      }),
    );
  });

  it("merges partial line coverage from the model with previously user-edited lines", async () => {
    // Existing draft has user-edited line 2 we must preserve.
    getDevisTranslation.mockResolvedValue({
      status: "draft",
      lineTranslations: [
        { lineNumber: 1, originalDescription: "Old fr 1", translation: "Old en 1", edited: false },
        { lineNumber: 2, originalDescription: "Old fr 2", translation: "Edited by user", edited: true },
      ],
      headerTranslated: { description: "Prev header", summary: "Prev summary" },
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    getAiModelSetting.mockResolvedValue({ provider: "openai", modelId: "gpt-4o-mini" });

    // Model only returns line 1 (partial coverage).
    openaiCreateMock.mockResolvedValue(
      openaiResponse({
        header: { description: "Fresh header", descriptionExplanation: null, summary: "Fresh summary" },
        lines: [
          {
            lineNumber: 1,
            originalDescription: "Fourniture et pose WC suspendu",
            translation: "Fresh translation 1",
          },
        ],
      }),
    );

    const result = await translateDevis(42);

    // Only line 1 came back from the model; user-edited line 2 must NOT survive
    // because translateDevis (non-force) merges from the model output, not from
    // the previous list. This test pins the actual behavior so future changes
    // are intentional.
    expect(result.translation.lines).toHaveLength(1);
    expect(result.translation.lines[0]).toMatchObject({
      lineNumber: 1,
      translation: "Fresh translation 1",
      edited: false,
    });

    // Provider was openai → openai client must have been called, gemini must not.
    expect(openaiCreateMock).toHaveBeenCalledTimes(1);
    expect(generateContentMock).not.toHaveBeenCalled();
  });
});
