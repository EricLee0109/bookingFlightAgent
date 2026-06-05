import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import {
  ParsedPassengerMessageSchema,
  type ParsedPassengerMessage,
} from '../contracts/passenger';
import { type PassengerMessageParser } from './passenger-message-parser';

type ParsedMessage = {
  parsed?: ParsedPassengerMessage | null;
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

export type OpenAIPassengerMessageParserOptions = {
  client?: OpenAIChatCompletionsClient;
  model?: string;
};

const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';

/**
 * Creates the OpenAI parser for natural passenger-related Telegram messages.
 *
 * Boundary rules:
 * - Extract intent and passenger mentions into strict structured JSON.
 * - Never read or choose profiles from the local passenger DB.
 * - Never call Telegram, Playwright, or 1Booking automation.
 */
export function createOpenAIPassengerMessageParser(
  options: OpenAIPassengerMessageParserOptions = {},
): PassengerMessageParser {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!options.client && !apiKey) {
    throw new Error(
      'Missing OPENAI_API_KEY. Set OPENAI_API_KEY before parsing passenger messages.',
    );
  }

  const client =
    options.client ??
    new OpenAI({
      apiKey: apiKey as string,
    });
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;

  return {
    async parse(rawMessage: string) {
      const completion = await client.chat.completions.parse({
        model,
        messages: [
          {
            role: 'system',
            content: buildPassengerParserSystemPrompt(),
          },
          {
            role: 'user',
            content: rawMessage,
          },
        ],
        response_format: zodResponseFormat(
          ParsedPassengerMessageSchema,
          'parsed_passenger_message',
        ),
      });
      const message = completion.choices[0]?.message;

      if (message?.refusal) {
        throw new Error(
          `OpenAI passenger parser refused the request: ${message.refusal}`,
        );
      }

      if (!message?.parsed) {
        const contentPreview = message?.content?.slice(0, 200) ?? 'empty content';

        throw new Error(
          `OpenAI passenger parser returned invalid structured output: ${contentPreview}`,
        );
      }

      return ParsedPassengerMessageSchema.parse(message.parsed);
    },
  };
}

/**
 * Builds the stable structured-output prompt for passenger natural language.
 */
export function buildPassengerParserSystemPrompt() {
  return [
    'You parse passenger-related messages from an internal Vietnamese travel operator.',
    'Return structured data only through the provided schema.',
    'Extract intent and passenger mentions. Never choose a final passenger profile.',
    'A separate local SQLite resolver decides which stored passenger matches.',
    '',
    'Intent rules:',
    '- attach_passenger: operator asks to use an existing passenger for a case.',
    '- provide_new_passenger: operator provides a passenger name, gender, or optional DOB.',
    '- update_passenger_fields: operator adds missing passenger fields or optional DOB.',
    '- confirm_passenger: operator confirms the currently proposed passenger.',
    '- reject_passenger: operator rejects the proposed passenger or asks for another match.',
    '- unknown: passenger intent is unclear.',
    '',
    'Extraction rules:',
    '- Extract only fullName, gender, and optional DOB for each passenger mention.',
    '- Put the operator-provided passenger name or lookup name in fullName.',
    '- Infer gender from clear Vietnamese honorifics when possible: anh/ong/chu are male; chi/co/ba are female.',
    '- Treat standalone "Nam" or "Nữ"/"Nu" as a gender-only update with fullName null.',
    '- Treat quick input such as "Nữ, Nguyễn Thị Oanh" or "Nam Nguyễn Văn A" as gender plus fullName.',
    '- Treat "sinh 02/01/1995" as a DOB-only update with fullName and gender null.',
    '- Extract case code such as BK-20260525-162456 when present.',
    '- Normalize DOB to yyyy-mm-dd when present.',
    '- Use null for information that the operator did not provide.',
    '- Do not infer a final local DB passenger identity.',
  ].join('\n');
}
