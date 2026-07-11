module.exports = {
  presets: ['@react-native/babel-preset'],
  plugins: [
    // Inlines the production API URL at bundle time (see src/config.ts).
    ['transform-inline-environment-variables', {include: ['CITYSHIELD_API_URL']}],
  ],
};
