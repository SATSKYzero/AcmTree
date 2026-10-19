// ================================================================
// 注册冒烟测试的模块解析钩子（scripts/smoke/register.mjs）
// 用法：node --import <本文件> <smoke 文件>
// ================================================================
import { register } from 'node:module';

register(new URL('./specifier-loader.mjs', import.meta.url));
