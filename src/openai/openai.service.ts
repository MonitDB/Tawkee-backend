import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { CreateEmbeddingResponse } from "openai/resources";


@Injectable()
export class OpenAiService {
  private readonly openai: OpenAI;
  private readonly logger = new Logger(OpenAiService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');

    if (!apiKey) {
      this.logger.error('OpenAI API key is not configured!');
    }

    this.openai = new OpenAI({
      apiKey,
    });
  }

  /**
   * Map AIModel enum to actual model IDs for different LLM providers
   * @param model The AIModel enum value
   * @returns The actual model ID to use with the API
   */
  private getModelId(model: string): string {
    // Default to GPT-4o if no model specified
    if (!model) return 'gpt-4o';

    // Map AIModel enum values to actual model IDs
    const modelMap = {
      GPT_4_1: 'gpt-4-0125-preview', // GPT-4 Turbo
      GPT_4_1_MINI: 'gpt-4-0125-preview',
      GPT_4_O_MINI: 'gpt-4o-mini',
      GPT_4_O: 'gpt-4o', // The newest OpenAI model is "gpt-4o" which was released May 13, 2024
      OPEN_AI_O3_MINI: 'gpt-3.5-turbo',
      OPEN_AI_O4_MINI: 'gpt-4o-mini',
      OPEN_AI_O3: 'gpt-3.5-turbo',
      OPEN_AI_O1: 'gpt-3.5-turbo',
      GPT_4: 'gpt-4',
      // For non-OpenAI models, we'll fallback to GPT-4o but log a warning
      CLAUDE_3_5_SONNET: 'gpt-4o',
      CLAUDE_3_7_SONNET: 'gpt-4o',
      CLAUDE_3_5_HAIKU: 'gpt-4o',
      DEEPINFRA_LLAMA3_3: 'gpt-4o',
      QWEN_2_5_MAX: 'gpt-4o',
      DEEPSEEK_CHAT: 'gpt-4o',
      SABIA_3: 'gpt-4o',
    };

    if (modelMap[model]) {
      // If it's not an OpenAI model, log a warning that we're using a fallback
      if (
        model.startsWith('CLAUDE') ||
        model.startsWith('DEEPINFRA') ||
        model.startsWith('QWEN') ||
        model.startsWith('DEEPSEEK') ||
        model.startsWith('SABIA')
      ) {
        this.logger.warn(
          `Non-OpenAI model ${model} requested, falling back to gpt-4o`
        );
      }

      return modelMap[model];
    }

    // Default fallback
    this.logger.warn(
      `Unknown model ${model} requested, falling back to gpt-4o`
    );
    return 'gpt-4o';
  }

  /**
   * Generate a response using the specified model
   * @param prompt The prompt to send to OpenAI
   * @param modelPreference The preferred model to use (AIModel enum value)
   * @param systemMessage Optional system message to set the context
   * @returns The generated text response
   */
  async generateResponse(
    prompt: string,
    modelPreference?: string,
    systemMessage?: string
  ): Promise<string> {
    try {
      const messages = [];

      // Add system message if provided
      if (systemMessage) {
        messages.push({
          role: 'system',
          content: systemMessage,
        });
      }

      // Add user prompt
      messages.push({
        role: 'user',
        content: prompt,
      });

      // Get the appropriate model ID based on the model preference
      const modelId = this.getModelId(modelPreference);
      this.logger.debug(`Using model ${modelId} for generation`);

      // Make the API call to OpenAI
      const response = await this.openai.chat.completions.create({
        model: modelId,
        messages,
        temperature: 0.7,
        max_tokens: 500,
      });

      return response.choices[0].message.content;
    } catch (error) {
      this.logger.error(
        `Error generating response from OpenAI: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Build a prompt with communication style guide and goal guide
   * @param userMessage The user's message
   * @param communicationGuide Guide for the communication style (FORMAL, NORMAL, RELAXED)
   * @param goalGuide Guide for the agent type (SUPPORT, SALE, PERSONAL)
   * @param agentSettings Additional agent settings to include in the prompt
   * @param conversationContext Optional previous conversation history
   * @returns A formatted prompt for OpenAI
   */
  buildPrompt(
    userMessage: string,
    communicationGuide: string,
    goalGuide: string,
    agent: any,
    conversationContext?: string,
    retrievedContext?: string,
  ): string {
    // Base system instruction
    let prompt = `You are an AI assistant named ${agent.name || "Assistant"}.`;

    // Add professional context if available
    if (agent.jobName || agent.jobSite || agent.jobDescription) {
      prompt += "\n\n## PROFESSIONAL CONTEXT";

      if (agent.jobName) {
        prompt += `\n- Role: ${agent.jobName}`;
      }

      if (agent.jobSite) {
        prompt += `\n- Company Website: ${agent.jobSite}`;
      }

      if (agent.jobDescription) {
        prompt += `\n- Job Description: ${agent.jobDescription}`;
      }
    }

    // Add communication guide
    prompt += `\n\n## COMMUNICATION STYLE GUIDE\n${communicationGuide}`;

    // Add goal guide
    prompt += `\n\n## GOAL GUIDE\n${goalGuide}`;
    
    // Add behavioral settings if available
    if (agent.settings) {
      prompt += "\n\n## BEHAVIOR SETTINGS";
      
      // Emoji usage
      if (agent.settings.enabledEmoji === false) {
        prompt += "\n- Do not use emojis in your responses.";
      } else {
        prompt += "\n- Feel free to use appropriate emojis in your responses when suitable.";
      }
      
      // Subject limitations
      if (agent.settings.limitSubjects === true) {
        prompt += "\n- Only discuss topics directly related to the company, product, or your specific role. Politely decline to discuss unrelated subjects.";
      }
      
      // Human transfer capability
      if (agent.settings.enabledHumanTransfer === true) {
        prompt += "\n- If you can't resolve an issue or if the user explicitly asks for a human, acknowledge that you can transfer them to a human agent.";
      }
      
      // Message splitting preference
      if (agent.settings.splitMessages === true) {
        prompt += "\n- Keep responses concise. If you need to provide a lengthy answer, break it into multiple shorter paragraphs.";
      } else {
        prompt += "\n- Aim to provide complete answers in a single response.";
      }
      
      // Timezone awareness
      if (agent.settings.timezone) {
        prompt += `\n- When discussing time-related matters, consider the user's timezone (${agent.settings.timezone}).`;
      }
    }

    // Add any specific training or intentions if available
    if (agent.trainings && agent.trainings.length > 0) {
      prompt += "\n\n## SPECIFIC KNOWLEDGE AND TRAINING";
      agent.trainings.forEach((training) => {
        prompt += `\n- ${training.title}: ${training.content}`;
      });
    }

    // Add any specific intentions if available
    if (agent.intentions && agent.intentions.length > 0) {
      prompt += "\n\n## BEHAVIOR INTENTIONS";
      agent.intentions.forEach((intention) => {
        prompt += `\n- ${intention.title}: ${intention.content}`;
      });
    }

    // Add retrieved context from RAG if available
    if (retrievedContext && retrievedContext.length > 0) {
      prompt += "\n\n## RETRIEVED KNOWLEDGE";
      prompt += `\n${retrievedContext}`;
      prompt += "\n\nUse the above retrieved knowledge to inform your response when relevant to the user's query.";
    }

    // Add conversation history if available
    if (conversationContext && conversationContext.length > 0) {
      prompt += `\n\n## CONVERSATION HISTORY\n${conversationContext}`;
    }

    // Add context about the current user message
    prompt += `\n\n## CURRENT USER MESSAGE\n${userMessage}`;

    // Final instruction
    prompt += `\n\nRespond to the user message according to your professional context, communication style guide, goal guide, and behavior settings provided above. Be concise, helpful, and true to your assigned role and communication style. Do not include labels like "Assistant:" in your response.`;

    return prompt;
  }

  /**
   * Generate a complete response for a user message based on agent settings
   * @param userMessage The user's message to respond to
   * @param agent The agent configuration
   * @param communicationGuide The communication style guide
   * @param goalGuide The goal guide
   * @param conversationContext Optional previous conversation history
   * @returns The AI-generated response
   */
  async generateAgentResponse(
    userMessage: string,
    agent: any,
    communicationGuide: string,
    goalGuide: string,
    conversationContext?: string,
    retrievedContext?: string, // New parameter for RAG context
  ): Promise<string> {
    // Build the prompt incorporating all agent settings and guides
    const prompt = this.buildPrompt(
      userMessage,
      communicationGuide,
      goalGuide,
      agent,
      conversationContext,
      retrievedContext, // Pass retrieved context to buildPrompt
    );

    this.logger.debug(
      `Generated prompt for OpenAI: ${prompt.substring(0, 100)}...`,
    );

    // Determine the model to use
    let modelPreference = "GPT_4_O"; // Default to GPT-4o
    
    // If agent has settings with a preferred model, use that instead
    if (agent.settings && agent.settings.preferredModel) {
      modelPreference = agent.settings.preferredModel;
      this.logger.debug(`Using agent's preferred model: ${modelPreference}`);
    }
    
    // Generate the response from OpenAI using the appropriate model
    return this.generateResponse(prompt, modelPreference);
  }


  /**
   * Generate embeddings for text using OpenAI
   * @param text The text to generate embeddings for
   * @returns An array of embedding values
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      this.logger.debug(`Generating embedding for text: ${text.substring(0, 50)}...`);
      
      const response: CreateEmbeddingResponse = await this.openai.embeddings.create({
        model: "text-embedding-3-small", // Using OpenAI's latest embedding model
        input: text,
        encoding_format: "float",
      });
      
      this.logger.debug(`Generated embedding with ${response.data[0].embedding.length} dimensions`);
      
      return response.data[0].embedding;
    } catch (error) {
      this.logger.error(`Error generating embedding: ${error.message}`);
      throw error;
    }
  }
}