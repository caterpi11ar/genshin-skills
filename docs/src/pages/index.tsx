import type { ReactNode } from 'react'
import Link from '@docusaurus/Link'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import Heading from '@theme/Heading'
import Layout from '@theme/Layout'

import styles from './index.module.css'

const features = [
  {
    title: '智能日常代理',
    icon: '🎮',
    description: '通过视觉识别与确定性键鼠步骤，自动领取月卡、邮件、纪行、成就和活动奖励。',
  },
  {
    title: '技能系统',
    icon: '⚡',
    description: '模块化的技能架构，支持自定义扩展。每个技能独立运行，灵活组合。',
  },
  {
    title: '云游戏适配',
    icon: '☁️',
    description: '专为云游戏平台设计，无需本地安装原神客户端，低资源占用。',
  },
  {
    title: '可视化监控',
    icon: '📊',
    description: '实时 TUI 仪表盘，随时掌握任务执行状态、日志输出和运行数据。',
  },
]

function HomepageHero() {
  const { siteConfig } = useDocusaurusContext()
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroContent}>
          <span className={styles.heroBadge}>开源 · 视觉 AI · 云游戏</span>
          <Heading as="h1" className={styles.heroTitle}>
            {siteConfig.title}
          </Heading>
          <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
          <div className={styles.heroButtons}>
            <Link className={styles.primaryButton} to="/docs/getting-started">
              快速开始
            </Link>
            <Link
              className={styles.secondaryButton}
              href="https://github.com/caterpi11ar/giclaw"
            >
              GitHub
            </Link>
          </div>
          <div className={styles.heroHighlights}>
            <div className={styles.highlight}>
              <span className={styles.highlightIcon}>🎮</span>
              <span className={styles.highlightText}>5 项奖励流程已验收</span>
            </div>
            <div className={styles.highlight}>
              <span className={styles.highlightIcon}>☁️</span>
              <span className={styles.highlightText}>无需本地客户端</span>
            </div>
            <div className={styles.highlight}>
              <span className={styles.highlightIcon}>⚡</span>
              <span className={styles.highlightText}>模块化技能扩展</span>
            </div>
          </div>
        </div>

        <div className={styles.heroVisual}>
          <div className={styles.logoContainer}>
            <div className={`${styles.energyRing} ${styles.ring1}`} />
            <div className={`${styles.energyRing} ${styles.ring2}`} />
            <div className={`${styles.energyRing} ${styles.ring3}`} />
            <img
              src="/img/logo.jpeg"
              alt="giclaw Logo"
              className={styles.logo}
            />
          </div>
        </div>
      </div>
    </header>
  )
}

function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className={styles.featuresInner}>
        <Heading as="h2" className={styles.sectionTitle}>
          为什么选择 giclaw
        </Heading>
        <div className={styles.featuresCard}>
          {features.map(({ title, icon, description }, idx) => (
            <div
              key={idx}
              className={styles.featureCell}
              style={{ animationDelay: `${idx * 0.1}s` }}
            >
              <div className={styles.featureDecorator}>
                <div className={styles.decoratorGrid} />
                <div className={styles.decoratorIcon}>{icon}</div>
              </div>
              <Heading as="h3" className={styles.featureTitle}>
                {title}
              </Heading>
              <p className={styles.featureDescription}>{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function HomepageCta() {
  return (
    <section className={styles.cta}>
      <div className={styles.ctaBox}>
        <Heading as="h2" className={styles.ctaTitle}>
          开始你的自动化之旅
        </Heading>
        <p className={styles.ctaDescription}>
          五分钟完成配置，让 AI 代理处理重复性的奖励领取
        </p>
        <div className={styles.ctaButtons}>
          <Link className={styles.primaryButton} to="/docs/getting-started">
            快速开始
          </Link>
          <Link className={styles.ctaOutlineButton} to="/docs/skills/overview">
            技能开发
          </Link>
          <Link
            className={styles.ctaOutlineButton}
            href="https://github.com/caterpi11ar/giclaw"
          >
            GitHub
          </Link>
        </div>
      </div>
    </section>
  )
}

export default function Home(): ReactNode {
  return (
    <Layout description="专为《原神》云游戏打造的视觉 AI 奖励领取代理">
      <div className={styles.pageWrapper}>
        <div className={styles.bgGrid} />
        <div className={`${styles.bgBlob} ${styles.bgBlob1}`} />
        <div className={`${styles.bgBlob} ${styles.bgBlob2}`} />
        <div className={`${styles.bgBlob} ${styles.bgBlob3}`} />

        <HomepageHero />
        <HomepageFeatures />
        <HomepageCta />
      </div>
    </Layout>
  )
}
