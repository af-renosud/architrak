import { describe, it, expect } from "vitest";
import { numberToFrenchWords } from "../financial-utils";

describe("numberToFrenchWords", () => {
  describe("zero and basic units", () => {
    it("converts 0", () => {
      expect(numberToFrenchWords(0)).toBe("Z\u00C9RO EUROS");
    });

    it("converts 1 (singular euro)", () => {
      expect(numberToFrenchWords(1)).toBe("UN EURO");
    });

    it("converts 2", () => {
      expect(numberToFrenchWords(2)).toBe("DEUX EUROS");
    });

    it("converts 9", () => {
      expect(numberToFrenchWords(9)).toBe("NEUF EUROS");
    });
  });

  describe("teens (10-19)", () => {
    it("converts 10", () => {
      expect(numberToFrenchWords(10)).toBe("DIX EUROS");
    });

    it("converts 11", () => {
      expect(numberToFrenchWords(11)).toBe("ONZE EUROS");
    });

    it("converts 17", () => {
      expect(numberToFrenchWords(17)).toBe("DIX-SEPT EUROS");
    });

    it("converts 19", () => {
      expect(numberToFrenchWords(19)).toBe("DIX-NEUF EUROS");
    });
  });

  describe("standard tens (20-69)", () => {
    it("converts 20", () => {
      expect(numberToFrenchWords(20)).toBe("VINGT EUROS");
    });

    it("converts 21 with ET", () => {
      expect(numberToFrenchWords(21)).toBe("VINGT ET UN EUROS");
    });

    it("converts 25", () => {
      expect(numberToFrenchWords(25)).toBe("VINGT-CINQ EUROS");
    });

    it("converts 30", () => {
      expect(numberToFrenchWords(30)).toBe("TRENTE EUROS");
    });

    it("converts 31 with ET", () => {
      expect(numberToFrenchWords(31)).toBe("TRENTE ET UN EUROS");
    });

    it("converts 50", () => {
      expect(numberToFrenchWords(50)).toBe("CINQUANTE EUROS");
    });

    it("converts 69", () => {
      expect(numberToFrenchWords(69)).toBe("SOIXANTE-NEUF EUROS");
    });
  });

  describe("soixante-dix range (70-79)", () => {
    it("converts 70", () => {
      expect(numberToFrenchWords(70)).toBe("SOIXANTE-DIX EUROS");
    });

    it("converts 71 with ET", () => {
      expect(numberToFrenchWords(71)).toBe("SOIXANTE ET ONZE EUROS");
    });

    it("converts 75", () => {
      expect(numberToFrenchWords(75)).toBe("SOIXANTE-QUINZE EUROS");
    });

    it("converts 79", () => {
      expect(numberToFrenchWords(79)).toBe("SOIXANTE-DIX-NEUF EUROS");
    });
  });

  describe("quatre-vingts range (80-99)", () => {
    it("converts 80 with trailing S", () => {
      expect(numberToFrenchWords(80)).toBe("QUATRE-VINGTS EUROS");
    });

    it("converts 81 without trailing S", () => {
      expect(numberToFrenchWords(81)).toBe("QUATRE-VINGT-UN EUROS");
    });

    it("converts 90", () => {
      expect(numberToFrenchWords(90)).toBe("QUATRE-VINGT-DIX EUROS");
    });

    it("converts 91", () => {
      expect(numberToFrenchWords(91)).toBe("QUATRE-VINGT-ONZE EUROS");
    });

    it("converts 99", () => {
      expect(numberToFrenchWords(99)).toBe("QUATRE-VINGT-DIX-NEUF EUROS");
    });
  });

  describe("hundreds", () => {
    it("converts 100", () => {
      expect(numberToFrenchWords(100)).toBe("CENT EUROS");
    });

    it("converts 200 with trailing S", () => {
      expect(numberToFrenchWords(200)).toBe("DEUX CENTS EUROS");
    });

    it("converts 201 without trailing S", () => {
      expect(numberToFrenchWords(201)).toBe("DEUX CENT UN EUROS");
    });

    it("converts 500", () => {
      expect(numberToFrenchWords(500)).toBe("CINQ CENTS EUROS");
    });

    it("converts 999", () => {
      expect(numberToFrenchWords(999)).toBe("NEUF CENT QUATRE-VINGT-DIX-NEUF EUROS");
    });
  });

  describe("thousands", () => {
    it("converts 1000", () => {
      expect(numberToFrenchWords(1000)).toBe("MILLE EUROS");
    });

    it("converts 2000", () => {
      expect(numberToFrenchWords(2000)).toBe("DEUX MILLE EUROS");
    });

    it("converts 1500", () => {
      expect(numberToFrenchWords(1500)).toBe("MILLE CINQ CENTS EUROS");
    });

    it("converts 10000", () => {
      expect(numberToFrenchWords(10000)).toBe("DIX MILLE EUROS");
    });

    it("converts 999999", () => {
      expect(numberToFrenchWords(999999)).toBe("NEUF CENT QUATRE-VINGT-DIX-NEUF MILLE NEUF CENT QUATRE-VINGT-DIX-NEUF EUROS");
    });
  });

  describe("millions", () => {
    it("converts 1000000", () => {
      expect(numberToFrenchWords(1000000)).toBe("UN MILLION EUROS");
    });

    it("converts 2000000", () => {
      expect(numberToFrenchWords(2000000)).toBe("DEUX MILLIONS EUROS");
    });

    it("converts 1500000", () => {
      expect(numberToFrenchWords(1500000)).toBe("UN MILLION CINQ CENT MILLE EUROS");
    });
  });

  describe("amounts with centimes", () => {
    it("converts 6733.10 with centimes", () => {
      expect(numberToFrenchWords(6733.1)).toBe("SIX MILLE SEPT CENT TRENTE-TROIS EUROS ET DIX CENTIMES");
    });

    it("converts 100.01 with singular centime", () => {
      expect(numberToFrenchWords(100.01)).toBe("CENT EUROS ET UN CENTIME");
    });

    it("converts 1.99", () => {
      expect(numberToFrenchWords(1.99)).toBe("UN EURO ET QUATRE-VINGT-DIX-NEUF CENTIMES");
    });

    it("converts 0.50 with zero euros", () => {
      expect(numberToFrenchWords(0.5)).toBe("Z\u00C9RO EUROS ET CINQUANTE CENTIMES");
    });

    it("converts 1234.56", () => {
      expect(numberToFrenchWords(1234.56)).toBe("MILLE DEUX CENT TRENTE-QUATRE EUROS ET CINQUANTE-SIX CENTIMES");
    });
  });

  describe("floating-point drift and carry edge cases", () => {
    it("handles 1.999 by rounding to 2.00 (carry from cents)", () => {
      expect(numberToFrenchWords(1.999)).toBe("DEUX EUROS");
    });

    it("handles 0.995 by rounding to 1.00 (carry from sub-euro)", () => {
      expect(numberToFrenchWords(0.995)).toBe("UN EURO");
    });

    it("handles 99.999 by rounding to 100.00", () => {
      expect(numberToFrenchWords(99.999)).toBe("CENT EUROS");
    });

    it("handles 2.005 by rounding cents up", () => {
      expect(numberToFrenchWords(2.005)).toBe("DEUX EUROS ET UN CENTIME");
    });
  });

  describe("real-world certificate amounts", () => {
    it("converts 5610.92 (typical Devis amount)", () => {
      expect(numberToFrenchWords(5610.92)).toBe("CINQ MILLE SIX CENT DIX EUROS ET QUATRE-VINGT-DOUZE CENTIMES");
    });

    it("converts 25000 (round contract amount)", () => {
      expect(numberToFrenchWords(25000)).toBe("VINGT-CINQ MILLE EUROS");
    });

    it("converts 150000.00 (large contract)", () => {
      expect(numberToFrenchWords(150000)).toBe("CENT CINQUANTE MILLE EUROS");
    });
  });
});
