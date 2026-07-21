// ─── src/components/LanguageSwitcher.tsx ─────────────────────────────────────
// Compact EN / БГ pill toggle, used on screens without a settings section.
import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import {useI18n} from '../context/LanguageContext';
import {Colors, radius, font} from '../theme';
import {useThemedStyles} from '../context/ThemeContext';
import {Language} from '../i18n/translations';

const OPTIONS: {value: Language; label: string}[] = [
  {value: 'bg', label: 'БГ'},
  {value: 'en', label: 'EN'},
];

export default function LanguageSwitcher() {
  const {language, setLanguage} = useI18n();
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.wrap}>
      {OPTIONS.map(opt => {
        const active = language === opt.value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[styles.pill, active && styles.pillActive]}
            onPress={() => setLanguage(opt.value)}
            activeOpacity={0.7}>
            <Text style={[styles.label, active && styles.labelActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 2,
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
  },
  pillActive: {backgroundColor: colors.primary},
  label: {
    fontSize: font.sizes.xs,
    fontWeight: font.weights.semibold,
    color: colors.textMuted,
  },
  labelActive: {color: colors.white},
});
