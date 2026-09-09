import { useCallback, useMemo } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { translate } from "./translations";

export type { Language } from "./translations";
export { TRANSLATIONS, translate } from "./translations";

export function useTranslation() {
  const language = useSettingsStore((state) => state.language);
  const setLanguage = useSettingsStore((state) => state.setLanguage);
  const t = useCallback((text: string) => translate(text, language), [language]);

  return useMemo(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );
}
