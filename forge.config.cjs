module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/{better-sqlite3,ffprobe-static}/**/*'
    },
    executableName: 'PersonalMediaAddon',
    name: 'Nuvi-Flow',
    ignore: [
      /^\/\.git(?:\/|$)/,
      /^\/\.github(?:\/|$)/,
      /^\/data(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/tests(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/docker-compose(?:\..+)?\.ya?ml$/,
      /^\/Dockerfile$/,
      /^\/README\.md$/
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'personal_media_addon',
        authors: 'Personal Media Addon contributors and Nuvi-Flow contributors',
        description: 'Stream a personal movie and TV library through a private Stremio-compatible addon.'
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32']
    }
  ]
};
