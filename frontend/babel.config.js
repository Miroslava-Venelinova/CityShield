module.exports = {
  presets: ['@react-native/babel-preset'],
  plugins: [
    // Inlines the production API URL and OneSignal app id at bundle time
    // (see src/config.ts).
    ['transform-inline-environment-variables',
      {include: ['CITYSHIELD_API_URL', 'ONESIGNAL_APP_ID']}],
  ],
};
