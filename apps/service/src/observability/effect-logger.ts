import { Layer, Logger } from "effect";

export const JsonLoggerLive: Layer.Layer<never> = Logger.layer([Logger.consoleJson]);
