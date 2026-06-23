import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import {
  ParsedFlightRequestSchema,
  type ParsedFlightRequest,
} from '../contracts/flight';
import { AIRPORT_CATALOG } from './airport-catalog';
import { type FlightRequestParser } from './flight-request-parser';

/**
 * Agent component for parsing raw operator text into the canonical flight request contract. - openAI
 *
 * Boundary rules:
 * - Owns OpenAI prompt construction and structured output validation.
 * - Does not format Telegram messages.
 * - Does not map data to Playwright automation input.
 * - Does not call 1Booking automation.
 */

type ParsedMessage = {
  parsed?: ParsedFlightRequest | null;
  content?: string | null;
  refusal?: string | null;
};

type OpenAIChatCompletionsClient = {
  chat: {
    completions: {
      parse(input: unknown): Promise<{
        choices: Array<{
          message?: ParsedMessage;
        }>;
      }>;
    };
  };
};

export type OpenAIFlightRequestParserOptions = {
  client?: OpenAIChatCompletionsClient;
  model?: string;
  today?: string;
  timeZone?: string;
};

const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';

/**
 * Creates the production AI parser backed by the official OpenAI API.
 *
 * This parser owns only text-to-JSON extraction. It never calls Telegram,
 * Playwright, or 1Booking automation directly.
 */
export function createOpenAIFlightRequestParser(
  options: OpenAIFlightRequestParserOptions = {},
): FlightRequestParser {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!options.client && !apiKey) {
    throw new Error(
      'Missing OPENAI_API_KEY. Set OPENAI_API_KEY or switch FLIGHT_PARSER_PROVIDER=mock.',
    );
  }

  const client =
    options.client ??
    new OpenAI({
      apiKey: apiKey as string,
    });
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;

  return {
    async parse(rawMessage: string) {
      const today = options.today ?? getTodayIsoDate(timeZone);
      const completion = await client.chat.completions.parse({
        model,
        messages: [
          {
            role: 'system',
            content: buildFlightParserSystemPrompt(today, timeZone),
          },
          {
            role: 'user',
            content: rawMessage,
          },
        ],
        response_format: zodResponseFormat(
          ParsedFlightRequestSchema,
          'parsed_flight_request',
        ),
      });

      const message = completion.choices[0]?.message;

      if (message?.refusal) {
        throw new Error(`OpenAI parser refused the request: ${message.refusal}`);
      }

      if (!message?.parsed) {
        const contentPreview = message?.content?.slice(0, 200) ?? 'empty content';

        throw new Error(
          `OpenAI parser returned invalid structured output: ${contentPreview}`,
        );
      }

      return ParsedFlightRequestSchema.parse(message.parsed);
    },
  };
}

/**
 * Builds the stable parser instruction used for Telegram flight requests.
 *
 * The airport catalog is included here so OpenAI can resolve common Vietnamese
 * airport names and aliases into our canonical IATA code/text pair.
 *
 * Keep business rules here so raw model output is constrained before it reaches
 * validation, mapping, or browser automation.
 */
export function buildFlightParserSystemPrompt(today: string, timeZone: string) {
  return [
    'You are a flight request parser for an internal Vietnamese travel operator.',
    'Extract only the structured fields required by the schema.',
    `Today is ${today} in time zone ${timeZone}. Resolve relative dates from this date.`,
    '',
    'Airport rules:',
    ...AIRPORT_CATALOG.map(
      (airport) =>
        `- ${airport.aliases.join(', ')} => ${airport.code} / ${airport.text}.`,
    ),
    '- If an airport is unclear, set both its code and text to null.',
    '',
    'Date and time rules:',
    '- Dates must be ISO yyyy-mm-dd.',
    '- preferredTime must be early_morning, morning, afternoon, night, specific_time, or null.',
    '- early_morning means 00:00-05:59. Use it for "sáng sớm", "rạng sáng", or overnight departures after midnight.',
    '- morning means 06:00-11:59. Use it for "sáng" or "buổi sáng".',
    '- afternoon means 12:00-17:59. Use it for "chiều" or "buổi chiều".',
    '- night means 18:00-23:59. Use it for "tối", "đêm", or "buổi tối".',
    '- Use specific_time only when the message contains an exact time; then set specificTime as HH:mm.',
    '- If no exact time exists, specificTime must be null.',
    '- Set resultRanking to cheapest only when the message asks for the cheapest or cheap flights, such as "rẻ nhất", "giá rẻ nhất", "chuyến rẻ", or "vé rẻ". Otherwise set resultRanking to null.',
    '',
    'Trip rules:',
    '- Use one_way unless the message clearly asks for round trip or a return date.',
    '- For round_trip, returnDate is required.',
    '',
    'Missing field rules:',
    '- Add missing required search fields to missingFields using schema field names.',
    '- Required search fields are fromAirportCode, fromAirportText, toAirportCode, toAirportText, departureDate.',
    '- Add returnDate when tripType is round_trip and returnDate is missing.',
    '- Do not invent unknown airports, dates, or times.',
  ].join('\n');
}

/**
 * Returns the current local date in ISO format for relative-date parsing.
 */
function getTodayIsoDate(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
