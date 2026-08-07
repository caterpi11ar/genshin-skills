import type { SidebarsConfig } from '@docusaurus/plugin-content-docs'

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'getting-started',
    'configuration',
    'models',
    'cli',
    'daemon-mode',
    'architecture',
    'roadmap',
    {
      type: 'category',
      label: '技能系统',
      items: [
        'skills/overview',
        'skills/writing-skills',
        'skills/built-in-skills',
      ],
    },
    'changelog',
    'contributing',
    'faq',
  ],
}

export default sidebars
