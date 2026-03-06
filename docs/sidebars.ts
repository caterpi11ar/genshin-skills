import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'getting-started',
    'installation',
    'configuration',
    'cli',
    'daemon-mode',
    'architecture',
    {
      type: 'category',
      label: '技能系统',
      items: [
        'skills/overview',
        'skills/writing-skills',
        'skills/built-in-skills',
      ],
    },
    'contributing',
  ],
};

export default sidebars;
