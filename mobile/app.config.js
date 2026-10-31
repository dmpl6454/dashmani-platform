// Build-time additions on top of app.json (Expo merges this over it).
//
// Sign in with Google (iOS): set GOOGLE_IOS_CLIENT_ID to the iOS OAuth client created in Google
// Cloud for bundle com.dashmani.employee (eas.json → build.production.env, or the shell for a
// local run). It must be known AT BUILD TIME: iOS returns the user to the app through the
// client's reversed id as a URL scheme, which is baked into Info.plist. Without it the login
// screen simply has no Google button.
module.exports = ({ config }) => {
  const iosClientId = (process.env.GOOGLE_IOS_CLIENT_ID || "").trim();
  if (!iosClientId) return config;
  const reversed = `com.googleusercontent.apps.${iosClientId.replace(/\.apps\.googleusercontent\.com$/, "")}`;
  const infoPlist = config.ios?.infoPlist ?? {};
  return {
    ...config,
    extra: { ...config.extra, googleIosClientId: iosClientId },
    ios: {
      ...config.ios,
      infoPlist: {
        ...infoPlist,
        CFBundleURLTypes: [...(infoPlist.CFBundleURLTypes ?? []), { CFBundleURLSchemes: [reversed] }],
      },
    },
  };
};
