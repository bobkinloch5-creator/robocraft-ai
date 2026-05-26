import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Globe2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Language = {
  code: string;
  label: string;
};

const STORAGE_KEY = "bloxsmith-language";
const TRANSLATE_ELEMENT_ID = "google_translate_element";

const LANGUAGES: Language[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "tr", label: "Turkish" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "zh-CN", label: "Chinese Simplified" },
  { code: "zh-TW", label: "Chinese Traditional" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "vi", label: "Vietnamese" },
  { code: "id", label: "Indonesian" },
  { code: "tl", label: "Filipino" },
  { code: "th", label: "Thai" },
  { code: "ms", label: "Malay" },
  { code: "bn", label: "Bengali" },
  { code: "ur", label: "Urdu" },
  { code: "fa", label: "Persian" },
  { code: "he", label: "Hebrew" },
  { code: "el", label: "Greek" },
  { code: "sv", label: "Swedish" },
  { code: "no", label: "Norwegian" },
  { code: "da", label: "Danish" },
  { code: "fi", label: "Finnish" },
  { code: "cs", label: "Czech" },
  { code: "ro", label: "Romanian" },
  { code: "hu", label: "Hungarian" },
  { code: "sk", label: "Slovak" },
  { code: "bg", label: "Bulgarian" },
  { code: "hr", label: "Croatian" },
  { code: "sr", label: "Serbian" },
  { code: "sl", label: "Slovenian" },
  { code: "lt", label: "Lithuanian" },
  { code: "lv", label: "Latvian" },
  { code: "et", label: "Estonian" },
  { code: "sw", label: "Swahili" },
  { code: "af", label: "Afrikaans" },
];

const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);
const INCLUDED_LANGUAGES = LANGUAGES.filter((language) => language.code !== "en")
  .map((language) => language.code)
  .join(",");

declare global {
  interface Window {
    google?: any;
    googleTranslateElementInit?: () => void;
  }
}

let translateLoader: Promise<void> | null = null;

function getStoredLanguage() {
  if (typeof window === "undefined") return "en";
  return window.localStorage.getItem(STORAGE_KEY) || "en";
}

function setTranslateCookie(language: string) {
  const value = `/en/${language}`;
  document.cookie = `googtrans=${value};path=/;SameSite=Lax`;

  if (window.location.hostname.includes(".")) {
    document.cookie = `googtrans=${value};path=/;domain=.${window.location.hostname};SameSite=Lax`;
  }
}

function clearTranslateCookie() {
  const expires = "Thu, 01 Jan 1970 00:00:00 GMT";
  document.cookie = `googtrans=;expires=${expires};path=/`;

  if (window.location.hostname.includes(".")) {
    document.cookie = `googtrans=;expires=${expires};path=/;domain=.${window.location.hostname}`;
  }
}

function ensureTranslateElement() {
  let mount = document.getElementById(TRANSLATE_ELEMENT_ID);
  if (!mount) {
    mount = document.createElement("div");
    mount.id = TRANSLATE_ELEMENT_ID;
    mount.setAttribute("aria-hidden", "true");
    document.body.appendChild(mount);
  }

  if (!mount.childElementCount && window.google?.translate?.TranslateElement) {
    new window.google.translate.TranslateElement(
      {
        pageLanguage: "en",
        includedLanguages: INCLUDED_LANGUAGES,
        autoDisplay: false,
      },
      TRANSLATE_ELEMENT_ID,
    );
  }
}

function loadGoogleTranslate() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.translate?.TranslateElement) {
    ensureTranslateElement();
    return Promise.resolve();
  }
  if (translateLoader) return translateLoader;

  translateLoader = new Promise<void>((resolve, reject) => {
    window.googleTranslateElementInit = () => {
      ensureTranslateElement();
      resolve();
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="translate.google.com/translate_a/element.js"]',
    );
    if (existing) {
      existing.addEventListener(
        "load",
        () => {
          ensureTranslateElement();
          resolve();
        },
        { once: true },
      );
      existing.addEventListener(
        "error",
        () => reject(new Error("Google Translate failed to load")),
        {
          once: true,
        },
      );
      return;
    }

    const script = document.createElement("script");
    script.src =
      "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
    script.async = true;
    script.onerror = () => reject(new Error("Google Translate failed to load"));
    document.head.appendChild(script);
  });

  return translateLoader;
}

function applyGoogleLanguage(language: string, attempts = 0) {
  const combo = document.querySelector<HTMLSelectElement>(".goog-te-combo");
  if (combo) {
    combo.value = language;
    combo.dispatchEvent(new Event("change"));
    return;
  }

  if (attempts < 20) {
    window.setTimeout(() => applyGoogleLanguage(language, attempts + 1), 150);
    return;
  }

  window.location.reload();
}

function protectTechnicalText() {
  document
    .querySelectorAll<HTMLElement>("pre, code, textarea, input, .notranslate, [data-notranslate]")
    .forEach((element) => {
      element.classList.add("notranslate");
      element.setAttribute("translate", "no");
    });
}

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const [language, setLanguage] = useState(getStoredLanguage);

  const languageLabel = useMemo(
    () => LANGUAGES.find((item) => item.code === language)?.label ?? "Language",
    [language],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = language;
    document.documentElement.dir = RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
  }, [language]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    protectTechnicalText();
    const observer = new MutationObserver(protectTechnicalText);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || language === "en") return;

    protectTechnicalText();
    setTranslateCookie(language);
    loadGoogleTranslate()
      .then(() => applyGoogleLanguage(language))
      .catch(() => {
        window.location.reload();
      });
  }, [language]);

  useEffect(() => {
    if (typeof window === "undefined" || language !== "en") return;
    clearTranslateCookie();
  }, [language]);

  const handleChange = (nextLanguage: string) => {
    setLanguage(nextLanguage);
    window.localStorage.setItem(STORAGE_KEY, nextLanguage);

    if (nextLanguage === "en") {
      clearTranslateCookie();
      window.location.reload();
      return;
    }

    setTranslateCookie(nextLanguage);
    protectTechnicalText();
    loadGoogleTranslate()
      .then(() => applyGoogleLanguage(nextLanguage))
      .catch(() => {
        window.location.reload();
      });
  };

  return (
    <label
      className={cn(
        "relative inline-flex items-center gap-2 rounded-lg border border-border/70 bg-surface/70 px-2.5 py-2 text-sm text-foreground shadow-sm transition hover:border-primary/40 hover:bg-surface",
        compact && "w-full",
      )}
      title={`Language: ${languageLabel}`}
    >
      <Globe2 className="h-4 w-4 shrink-0 text-primary-glow" />
      <span className="sr-only">Language</span>
      <select
        value={language}
        onChange={(event) => handleChange(event.target.value)}
        className={cn(
          "min-w-0 appearance-none bg-transparent pr-5 text-sm font-medium outline-none",
          compact ? "w-full" : "w-[9.75rem]",
        )}
        aria-label="Choose website language"
      >
        {LANGUAGES.map((item) => (
          <option key={item.code} value={item.code} className="bg-background text-foreground">
            {item.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-muted-foreground" />
    </label>
  );
}
