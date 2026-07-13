/**
 * Типи build-time env розширення (див. .env.example і wxt.config.ts).
 *
 * Оголошення зливається (interface merging) з ImportMetaEnv від WXT
 * (.wxt/types/globals.d.ts) і від vite/client (MODE, DEV, PROD).
 */
interface ImportMetaEnv {
  /**
   * Базовий URL бекенду з /v1 (напр. https://api.example/v1). Значення
   * вшивається у бандл через Vite `define` у wxt.config.ts, де воно вже
   * провалідоване: у production-збірці не-https падає на етапі збірки.
   */
  readonly VITE_API_BASE_URL?: string;
}
