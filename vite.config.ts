import { defineConfig, toolingPlugin } from '@dbtlr/tooling';

export default defineConfig({
  lint: {
    jsPlugins: ['@loomcli/eslint-plugin'],
    overrides: [
      {
        files: ['src/**'],
        rules: {
          '@loomcli/discarded-declaration': 'error',
          '@loomcli/host-bypass': 'error',
          '@loomcli/name-shape': 'error',
          '@loomcli/undescribed': 'error',
        },
      },
    ],
  },
  plugins: [
    toolingPlugin({
      fmt: { ignores: ['dist/**', 'spike/**'] },
      lint: { ignores: ['dist/**', 'spike/**'], rules: { 'one-var': 'off' } },
      node: { files: ['src/**'] },
    }),
  ],
});
