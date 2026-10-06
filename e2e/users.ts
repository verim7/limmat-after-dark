// One Clerk test user per browser so parallel projects never share "latest run" state.
// "+clerk_test" addresses are test identities on a Clerk development instance (no real email is sent).
export const testEmail = (browser: string) => `e2e-${browser}+clerk_test@example.com`
export const BROWSERS = ['chromium', 'webkit']
