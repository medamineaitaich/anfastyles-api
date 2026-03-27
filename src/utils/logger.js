const formatPrefix = (level) => {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}]`;
};

const logger = {
  info: (...args) => console.log(formatPrefix('INFO'), ...args),
  warn: (...args) => console.warn(formatPrefix('WARN'), ...args),
  error: (...args) => console.error(formatPrefix('ERROR'), ...args),
  debug: (...args) => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(formatPrefix('DEBUG'), ...args);
    }
  }
};

export default logger;

