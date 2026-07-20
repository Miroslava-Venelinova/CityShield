// ─── src/context/LanguageContext.tsx ─────────────────────────────────────────
import React, {
  createContext, useContext, useState, useEffect, useCallback, ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {translations, Language, TranslationKey} from '../i18n/translations';

const STORAGE_KEY = 'app_language';
const DEFAULT_LANGUAGE: Language = 'bg';

interface LanguageContextType {
  language:    Language;
  setLanguage: (lang: Language) => void;
  t:           (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextType>({
  language:    DEFAULT_LANGUAGE,
  setLanguage: () => {},
  t:           key => translations[DEFAULT_LANGUAGE][key],
});

export const LanguageProvider = ({children}: {children: ReactNode}) => {
  const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored === 'en' || stored === 'bg') {
          setLanguageState(stored);
        }
      } catch {
        // Storage unavailable — keep default
      }
    })();
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    AsyncStorage.setItem(STORAGE_KEY, lang).catch(() => {});
  }, []);

  const t = useCallback(
    (key: TranslationKey) => translations[language][key],
    [language],
  );

  return (
    <LanguageContext.Provider value={{language, setLanguage, t}}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useI18n = () => useContext(LanguageContext);
