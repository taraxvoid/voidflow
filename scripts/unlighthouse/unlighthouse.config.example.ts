// Example per-repo config, copy to the repo root as `unlighthouse.config.ts`.
// The runner supplies `site`, so it is not set here.
export default {
    scanner: {
        samples: 1,
        device: 'mobile',
        // Keep the run short: explicit routes, no crawling.
        // urls: ['/', '/friends', '/friends/o4us'],
        dynamicSampling: 3,
        skipJavascript: true,
    },
    lighthouseOptions: {
        onlyCategories: ['seo', 'performance'],
    },
    ci: {
        // Per-category minimum scores (0-100); the run exits non-zero if any fail.
        budget: {
            seo: 80,
            performance: 90,
        },
        buildStatic: false,
    },
}
