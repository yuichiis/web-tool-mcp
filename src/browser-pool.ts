import { logger } from './logger.js';
import { chromium, firefox, webkit, Browser, LaunchOptions } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export class BrowserPool {
  private browsers: Map<string, Browser> = new Map();
  private maxBrowsers: number;
  private browserTypes: string[];
  private currentBrowserIndex = 0;
  private headless: boolean;
  private lastUsedBrowserType: string = '';

  constructor() {
    // Read configuration from environment variables
    this.maxBrowsers = parseInt(process.env.MAX_BROWSERS || '3', 10);
    this.headless = process.env.BROWSER_HEADLESS !== 'false'; // Default to true
    
    // Configure browser types based on environment
    const browserTypesEnv = process.env.BROWSER_TYPES || 'chromium,firefox';
    this.browserTypes = browserTypesEnv.split(',').map(type => type.trim());
    
    logger.log(`[BrowserPool] Configuration: maxBrowsers=${this.maxBrowsers}, headless=${this.headless}, types=${this.browserTypes.join(',')}`);
  }

  async getBrowser(): Promise<Browser> {
    // Rotate between browser types for variety
    const browserType = this.browserTypes[this.currentBrowserIndex % this.browserTypes.length];
    this.currentBrowserIndex++;
    this.lastUsedBrowserType = browserType;

    const existingBrowser = this.browsers.get(browserType);
    if (existingBrowser) {
      const browser = existingBrowser;
      
      // Check if browser is still connected and healthy
      try {
        if (browser.isConnected()) {
          // Quick health check by trying to create and close a context
          // Use minimal options to avoid Firefox isMobile issues
          const testContext = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
          });
          await testContext.close();
          return browser;
        }
      } catch (error) {
        logger.log(`[BrowserPool] Browser ${browserType} health check failed:`, error);
        // Browser is unhealthy, remove it and close if possible
        this.browsers.delete(browserType);
        try {
          await browser.close();
        } catch (closeError) {
          logger.log(`[BrowserPool] Error closing unhealthy browser:`, closeError);
        }
      }
    }

    // Launch new browser
    logger.log(`[BrowserPool] Launching new ${browserType} browser`);
    
    const launchOptions = {
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
      ],
    };

    let browser: Browser;
    try {
      switch (browserType) {
        case 'chromium':
          browser = await this.launchChromium(launchOptions);
          break;
        case 'firefox':
          browser = await firefox.launch(launchOptions);
          break;
        case 'webkit':
          browser = await webkit.launch(launchOptions);
          break;
        default:
          browser = await this.launchChromium(launchOptions);
      }

      this.browsers.set(browserType, browser);
      
      // Clean up old browsers if we have too many
      if (this.browsers.size > this.maxBrowsers) {
        const oldestBrowser = this.browsers.entries().next().value;
        if (oldestBrowser) {
          try {
            await oldestBrowser[1].close();
          } catch (error) {
            logger.error(`[BrowserPool] Error closing old browser:`, error);
          }
          this.browsers.delete(oldestBrowser[0]);
        }
      }

      return browser;
    } catch (error) {
      logger.error(`[BrowserPool] Failed to launch ${browserType} browser:`, error);
      throw error;
    }
  }

  private async launchChromium(options: LaunchOptions): Promise<Browser> {
    const configuredPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (configuredPath) {
      return chromium.launch({ ...options, executablePath: configuredPath });
    }

    try {
      return await chromium.launch(options);
    } catch (bundledError) {
      if (process.platform !== 'win32') throw bundledError;
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const systemBrowsers = [
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ];
      const executablePath = systemBrowsers.find(existsSync);
      if (!executablePath) throw bundledError;
      logger.warn(`[BrowserPool] Playwright browser is unavailable; falling back to ${executablePath}`);
      return chromium.launch({ ...options, executablePath });
    }
  }
  async closeAll(): Promise<void> {
    logger.log(`[BrowserPool] Closing ${this.browsers.size} browsers`);
    
    const closePromises = Array.from(this.browsers.values()).map(browser => 
      browser.close().catch(error => 
        logger.error('Error closing browser:', error)
      )
    );
    
    await Promise.all(closePromises);
    this.browsers.clear();
  }

  getLastUsedBrowserType(): string {
    return this.lastUsedBrowserType;
  }
}