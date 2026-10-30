import miniAppPackage from "../package.json";

export default {
  env: {
    TARO_APP_API_BASE: JSON.stringify(process.env.TARO_APP_API_BASE || ""),
    TARO_APP_USE_MOCKS: JSON.stringify(process.env.TARO_APP_USE_MOCKS || "1"),
    TARO_APP_VERSION: JSON.stringify(miniAppPackage.version)
  },
  defineConstants: {
    TARO_APP_API_BASE: JSON.stringify(process.env.TARO_APP_API_BASE || ""),
    TARO_APP_USE_MOCKS: JSON.stringify(process.env.TARO_APP_USE_MOCKS || "1"),
    TARO_APP_VERSION: JSON.stringify(miniAppPackage.version)
  },
  mini: {},
  h5: {}
};
