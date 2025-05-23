import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from '../conversations/conversations.service';
import { EvolutionApiService } from '../evolution-api/evolution-api.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationsService: ConversationsService,
    private readonly evolutionApiService: EvolutionApiService
  ) {}

  async handleEvolutionWebhook(
    webhookData: any
  ): Promise<{ success: boolean }> {
    try {
      const event = webhookData?.event || 'unknown';
      const instance = webhookData?.instance || 'unknown';

      this.logger.log(`Received webhook: ${event} from instance ${instance}`);

      // Safety checks for required fields
      if (!event || !instance) {
        this.logger.warn('Missing required fields in webhook data');
        return { success: true }; // Return success to avoid retries
      }

      // Handle different event types from Evolution API
      // - messages.upsert: New message received
      // - connection.update: Connection status changed
      // - qr.updated: QR code updated
      // - send.message: Message was sent

      // Extract common data for all event types
      const instanceId = webhookData?.data?.instanceId || '';
      const dataObject = webhookData?.data || {};

      // Try to find the matching channel
      let eventChannel = await this.prisma.channel.findFirst({
        where: {
          config: {
            path: ['evolutionApi', 'instanceName'],
            equals: instance,
          },
        },
      });

      // If not found by instanceName, try to find by instanceId
      if (!eventChannel && instanceId) {
        eventChannel = await this.prisma.channel.findFirst({
          where: {
            config: {
              path: ['evolutionApi', 'instanceId'],
              equals: instanceId,
            },
          },
        });
      }

      // Process connection.update events to update channel status
      if (event === 'connection.update') {
        this.logger.log(
          `Processing connection update for instance: ${instance}`
        );

        const connectionState = webhookData?.data?.state || '';
        const statusReason = webhookData?.data?.statusReason;

        this.logger.log(
          `Connection state: ${connectionState}, Reason: ${statusReason}`
        );

        // Update the channel connection status if found
        if (eventChannel) {
          try {
            // Set connected=true if state is "open", connected=false otherwise
            const isConnected = connectionState === 'open';

            // Get the current config to update it properly
            const currentConfig = eventChannel.config as any;
            const evolutionApiConfig = currentConfig.evolutionApi || {};

            await this.prisma.channel.update({
              where: { id: eventChannel.id },
              data: {
                connected: isConnected,
                // Store the connection details in the config JSON
                config: {
                  ...currentConfig,
                  evolutionApi: {
                    ...evolutionApiConfig,
                    status: connectionState, // Update the status in evolutionApi config
                  },
                  connectionStatus: {
                    state: connectionState,
                    statusReason: statusReason,
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
            });

            this.logger.log(
              `Updated channel ${eventChannel.id} connection status to: ${isConnected ? 'connected' : 'disconnected'}`
            );
          } catch (error) {
            this.logger.error(
              `Failed to update channel connection status: ${error.message}`
            );
          }
        } else {
          this.logger.warn(
            `Received connection update for unknown instance: ${instance}`
          );
        }
      }

      // Store all events in the database for analysis (unless in test mode)
      if (!webhookData._testMode) {
        try {
          // We can only store webhook events if we have a channel
          if (eventChannel) {
            await this.prisma.webhookEvent.create({
              data: {
                event: event,
                instance: instance,
                instanceId: instanceId,
                rawData: dataObject,
                processed: true, // Mark as processed since we're taking appropriate action
                dateTime: new Date(),
                apikey: webhookData?.apikey || '',
                channel: {
                  connect: {
                    id: eventChannel.id,
                  },
                },
              },
            });

            this.logger.debug(`Stored ${event} event for analysis`);
          } else {
            this.logger.warn(
              `Could not store ${event} event: No matching channel found`
            );
          }
        } catch (error) {
          this.logger.warn(`Could not store ${event} event: ${error.message}`);
          this.logger.error(error);
        }
      } else {
        this.logger.debug(
          `Test mode enabled - skipping database storage for ${event} event`
        );
      }

      // Only continue processing for messages.upsert events
      if (event !== 'messages.upsert') {
        return { success: true };
      }

      // Skip messages from self (if we can determine that)
      if (webhookData?.data?.key?.fromMe) {
        this.logger.debug('Skipping message from self');
        return { success: true };
      }

      // Find the corresponding channel based on instanceName (which comes in the 'instance' property)
      const channel = await this.prisma.channel.findFirst({
        where: {
          config: {
            path: ['evolutionApi', 'instanceName'],
            equals: instance,
          },
        },
        include: {
          agent: true,
        },
      });

      if (!channel) {
        this.logger.warn(`No matching channel found for instance: ${instance}`);
        return { success: true }; // Return success to avoid retries
      }

      return this.processChannelWithWebhook(webhookData, channel);
    } catch (error) {
      this.logger.error(
        `Error processing webhook: ${error.message}`,
        error.stack
      );
      return { success: false };
    }
  }

  private async processWebhookEvent(webhookEventId: string): Promise<void> {
    const webhookEvent = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
      include: { channel: { include: { agent: true } } },
    });

    // Fetch the webhook event with all necessary relations
    if (!webhookEvent) {
      this.logger.error(
        `Could not find webhook event with ID: ${webhookEventId}`
      );
      return;
    }

    // Skip if the event was already processed
    if (webhookEvent.processed) {
      this.logger.debug(
        `Webhook event ${webhookEventId} already processed, skipping`
      );
      return;
    }

    // Ensure the webhook has a valid channel relationship
    if (!webhookEvent.channel) {
      this.logger.error(
        `Webhook event ${webhookEventId} has no associated channel`
      );
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          processed: true,
          processedAt: new Date(),
          error: 'No channel associated with this webhook event',
        },
      });
      return;
    }

    // Ensure the channel has a valid agent relationship
    if (!webhookEvent.channel.agent) {
      this.logger.error(
        `Channel ${webhookEvent.channel.id} has no associated agent`
      );
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          processed: true,
          processedAt: new Date(),
          error: 'No agent associated with the channel',
        },
      });
      return;
    }

    // Check if the agent is active before processing the message
    if (webhookEvent.channel.agent.isActive === false) {
      this.logger.log(
        `Skipping message processing for inactive agent: ${webhookEvent.channel.agent.id}`
      );

      // Mark the webhook as processed but don't take any action
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          processed: true,
          processedAt: new Date(),
          error: 'Skipped processing because agent is inactive',
        },
      });

      return;
    }

    // Validate required fields for message processing
    if (!webhookEvent.remoteJid) {
      this.logger.error(`Webhook event ${webhookEventId} has no remoteJid`);
      await this.prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          processed: true,
          processedAt: new Date(),
          error: 'Missing remoteJid, cannot identify message source',
        },
      });
      return;
    }

    try {
      // Process incoming message
      if (webhookEvent.event === 'messages.upsert' && !webhookEvent.fromMe) {
        const remoteJid = webhookEvent.remoteJid;
        const phoneNumber = remoteJid.split('@')[0];

        // Find or create chat
        let chat;
        try {
          this.logger.log(
            `Looking for existing chat with phone: ${phoneNumber} and agent: ${webhookEvent.channel.agentId}`
          );

          chat = await this.prisma.chat.findFirst({
            where: {
              whatsappPhone: phoneNumber,
              agentId: webhookEvent.channel.agentId,
            },
          });

          if (!chat) {
            this.logger.log(
              `No existing chat found, creating new chat for phone: ${phoneNumber}`
            );

            // Verify that we have all required fields for chat creation
            if (!webhookEvent.channel.agent?.workspaceId) {
              throw new Error(
                `Unable to create chat: Missing workspaceId from agent data`
              );
            }

            const chatData = {
              title: `Chat with ${phoneNumber}`,
              contextId: `whatsapp-${phoneNumber}`,
              whatsappPhone: phoneNumber,
              userName: webhookEvent.pushName || phoneNumber,
              workspaceId: webhookEvent.channel.agent.workspaceId,
              agentId: webhookEvent.channel.agentId,
            };

            this.logger.log(
              `Creating new chat with data: ${JSON.stringify(chatData)}`
            );

            chat = await this.prisma.chat.create({
              data: chatData,
            });

            this.logger.log(`Chat created successfully with ID: ${chat.id}`);

            // Create initial interaction
            this.logger.log(
              `Creating initial interaction for chat: ${chat.id}`
            );
            await this.prisma.interaction.create({
              data: {
                workspaceId: webhookEvent.channel.agent.workspaceId,
                agentId: webhookEvent.channel.agentId,
                chatId: chat.id,
                status: 'RUNNING',
              },
            });
            this.logger.log(
              `Interaction created successfully for chat: ${chat.id}`
            );
          } else {
            this.logger.log(`Found existing chat with ID: ${chat.id}`);
          }
        } catch (error) {
          this.logger.error(
            `Error in chat creation process: ${error.message}`,
            error.stack
          );

          // Update the webhook event with detailed error information
          await this.prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: {
              error: `Chat creation failed: ${error.message}`,
              processed: true,
              processedAt: new Date(),
            },
          });

          // Re-throw the error to be caught by the outer try-catch
          throw new Error(`Failed to create or find chat: ${error.message}`);
        }

        // Create message from webhook
        let message;
        try {
          this.logger.log(
            `Creating message for chat ${chat.id} with content: "${webhookEvent.messageContent}"`
          );

          // Validate message content
          if (!webhookEvent.messageContent) {
            this.logger.warn(
              `Empty message content for webhook ID: ${webhookEvent.id}, using fallback text`
            );
          }

          message = await this.prisma.message.create({
            data: {
              text: webhookEvent.messageContent || '(Empty message)',
              role: 'user',
              userName: webhookEvent.pushName,
              type: webhookEvent.messageType,
              whatsappMessageId: webhookEvent.messageId,
              whatsappTimestamp: webhookEvent.messageTimestamp,
              chatId: chat.id,
            },
          });

          this.logger.log(
            `Message created successfully with ID: ${message.id}`
          );

          // Mark chat as unread
          this.logger.log(`Updating chat ${chat.id} as unread`);
          await this.prisma.chat.update({
            where: { id: chat.id },
            data: {
              read: false,
              unReadCount: { increment: 1 },
            },
          });

          // Link message to webhook event
          this.logger.log(
            `Linking message ${message.id} to webhook event ${webhookEvent.id}`
          );
          await this.prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: {
              relatedMessageId: message.id,
              processed: true,
              processedAt: new Date(),
            },
          });
        } catch (error) {
          this.logger.error(
            `Error in message creation process: ${error.message}`,
            error.stack
          );

          // Update the webhook event with error information
          await this.prisma.webhookEvent.update({
            where: { id: webhookEvent.id },
            data: {
              error: `Message creation failed: ${error.message}`,
              processed: true,
              processedAt: new Date(),
            },
          });

          // Re-throw the error to be caught by the outer try-catch
          throw new Error(`Failed to create message: ${error.message}`);
        }

        // Get agent response (only if not in human talk mode)
        if (!chat.humanTalk) {
          this.logger.log(
            `Chat ${chat.id} is in automated mode, generating agent response`
          );

          try {
            // Validate required fields before calling conversation service
            if (!webhookEvent.channel.agent?.id) {
              throw new Error('Missing agent ID for generating response');
            }

            this.logger.log(
              `Requesting agent response for agent: ${webhookEvent.channel.agent.id}, message: "${webhookEvent.messageContent}"`
            );

            // Call agent API to process the message
            const agentResponse = await this.conversationsService.converse(
              webhookEvent.channel.agent.id,
              {
                contextId: chat.contextId,
                prompt: webhookEvent.messageContent || '(Empty message)',
                chatName: webhookEvent.pushName || phoneNumber,
              }
            );

            if (!agentResponse || !agentResponse.message) {
              throw new Error('Empty or invalid response from agent');
            }

            this.logger.log(
              `Got agent response: "${agentResponse.message.substring(0, 50)}${agentResponse.message.length > 50 ? '...' : ''}"`
            );

            // Create the bot response message
            this.logger.log(`Creating bot message in chat ${chat.id}`);
            const botMessage = await this.prisma.message.create({
              data: {
                text: agentResponse.message,
                role: 'assistant',
                type: 'conversation',
                chatId: chat.id,
                sentToEvolution: false, // Will be set to true after sending
              },
            });

            this.logger.log(`Bot message created with ID: ${botMessage.id}`);

            // Send the message to WhatsApp via Evolution API
            try {
              // Use the EvolutionApiService to send the message
              try {
                this.logger.log(
                  `Sending response to ${phoneNumber}: "${agentResponse.message}"`
                );

                const responseData =
                  await this.evolutionApiService.sendWhatsAppMessage(
                    webhookEvent.channel.agentId,
                    phoneNumber,
                    agentResponse.message
                  );

                // Check if we have a successful response
                if (
                  responseData &&
                  (responseData.key || responseData.success === true)
                ) {
                  // Update message status with success
                  await this.prisma.message.update({
                    where: { id: botMessage.id },
                    data: {
                      sentToEvolution: true,
                      sentAt: new Date(),
                      whatsappMessageId: responseData?.key?.id, // Store the WhatsApp message ID if available
                    },
                  });

                  this.logger.log(
                    `Message sent successfully to ${phoneNumber}`
                  );
                } else if (responseData && responseData.success === false) {
                  // We got a structured error response
                  this.logger.error(
                    `Failed to send WhatsApp message: ${responseData.error || 'Unknown error'}`
                  );

                  // Update message with error information
                  await this.prisma.message.update({
                    where: { id: botMessage.id },
                    data: {
                      failedAt: new Date(),
                      sentToEvolution: false,
                      failReason:
                        responseData.error ||
                        'Unknown error from Evolution API',
                    },
                  });

                  // If the instance isn't connected, log additional details
                  if (responseData.state) {
                    this.logger.error(
                      `WhatsApp instance not properly connected. State: ${responseData.state}. ` +
                        `User may need to rescan QR code for channel ID: ${webhookEvent.channel.id}`
                    );
                  }
                } else {
                  // Log unusual response
                  this.logger.warn(
                    `Unexpected response format from Evolution API: ${JSON.stringify(responseData)}`
                  );

                  // For development/testing, if the actual sending fails,
                  // we'll still mark it as sent but log the warning
                  this.logger.log(
                    `Would have sent to ${phoneNumber}: "${agentResponse.message}"`
                  );

                  // Mark as sent with warning
                  await this.prisma.message.update({
                    where: { id: botMessage.id },
                    data: {
                      sentToEvolution: true,
                      sentAt: new Date(),
                      failReason:
                        'Unexpected response format from Evolution API',
                    },
                  });
                }
              } catch (error) {
                // Real error during API call
                this.logger.error(
                  `Error sending message via Evolution API: ${error.message}`
                );

                // Update message with error information
                await this.prisma.message.update({
                  where: { id: botMessage.id },
                  data: {
                    failedAt: new Date(),
                    sentToEvolution: false,
                    failReason: `API error: ${error.message}`,
                  },
                });
              }
            } catch (error) {
              this.logger.error(
                `Failed to send message to Evolution API: ${error.message}`,
                error.stack
              );

              // Update message with error information
              await this.prisma.message.update({
                where: { id: botMessage.id },
                data: {
                  failedAt: new Date(),
                  failReason: error.message,
                },
              });
            }
          } catch (error) {
            this.logger.error(
              `Error getting agent response: ${error.message}`,
              error.stack
            );
          }
        }
      }
    } catch (error) {
      // Update the webhook event with error
      await this.prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          error: error.toString(),
          processed: true,
          processedAt: new Date(),
        },
      });
      this.logger.error(
        `Error processing webhook event: ${error.message}`,
        error.stack
      );
    }
  }

  /**
   * Helper function to determine if a message is from a group
   * @param remoteJid The remote JID from the message
   * @param dataObject The data object from the webhook
   * @param webhookData The full webhook data
   * @returns True if the message is from a group, false otherwise
   */
  private isGroupMessage(
    remoteJid: string,
    dataObject: any,
    webhookData: any
  ): boolean {
    // Check 3 conditions to identify group messages:

    // 1. remoteJid ending with @g.us (group) vs @s.whatsapp.net (private)
    const isGroupJid = remoteJid?.endsWith('@g.us');

    // 2. Message has senderKeyDistributionMessage attribute (present in group messages)
    const hasSenderKeyDistribution =
      !!dataObject?.message?.senderKeyDistributionMessage;

    // 3. JSON includes participant attribute (present in group messages)
    const hasParticipant = !!webhookData?.participant;

    // Log the detection for debugging
    if (isGroupJid || hasSenderKeyDistribution || hasParticipant) {
      this.logger.debug(
        `Group message detected: JID=${isGroupJid}, SenderKey=${hasSenderKeyDistribution}, Participant=${hasParticipant}`
      );

      // Additional details for debugging
      this.logger.debug(`Remote JID: ${remoteJid}`);
      if (hasParticipant) {
        this.logger.debug(`Participant: ${webhookData.participant}`);
      }
    }

    // Consider it a group message if any of the indicators are present
    return isGroupJid || hasSenderKeyDistribution || hasParticipant;
  }

  /**
   * Process Evolution webhook for a specific channel
   * @param webhookData The webhook data received from Evolution API
   * @param channel The channel matching the webhook instance
   */

  private async processChannelWithWebhook(
    webhookData: any,
    channel: any
  ): Promise<{ success: boolean }> {
    try {
      // Basic validation
      if (!webhookData) {
        this.logger.error(
          `Invalid webhook data: received ${typeof webhookData}`
        );
        return { success: false };
      }

      if (!channel || !channel.id) {
        this.logger.error(`Invalid channel data: ${JSON.stringify(channel)}`);
        return { success: false };
      }

      // Safely extract data with optional chaining, fallbacks, and additional logging
      const event = webhookData?.event || 'unknown';
      if (event === 'unknown') {
        this.logger.warn(`Missing event type in webhook data, using "unknown"`);
      }

      const instance = webhookData?.instance || 'unknown';
      if (instance === 'unknown') {
        this.logger.warn(`Missing instance in webhook data, using "unknown"`);
      }

      const dataObject = webhookData?.data || {};
      if (!webhookData?.data) {
        this.logger.warn(`Missing data object in webhook, using empty object`);
      }

      const instanceId = dataObject?.instanceId || '';
      const keyObject = dataObject?.key || {};
      if (!keyObject || Object.keys(keyObject).length === 0) {
        this.logger.warn(`Missing or empty key object in webhook data`);
      }

      const remoteJid = keyObject?.remoteJid || '';
      if (!remoteJid) {
        this.logger.warn(`Missing remoteJid in webhook data`);
      }

      const fromMe = keyObject?.fromMe || false;
      const messageId = keyObject?.id || '';
      const pushName = dataObject?.pushName || '';

      const messageType = dataObject?.messageType || 'unknown';
      if (messageType === 'unknown') {
        this.logger.warn(
          `Missing messageType in webhook data, using "unknown"`
        );
      }

      // Safely handle timestamps to avoid conversion errors
      let messageTimestamp;
      try {
        messageTimestamp = dataObject?.messageTimestamp || Date.now();
        // Validate that it's a number
        if (isNaN(Number(messageTimestamp))) {
          this.logger.warn(
            `Invalid messageTimestamp format: ${messageTimestamp}, using current time`
          );
          messageTimestamp = Date.now();
        }
      } catch (error) {
        this.logger.warn(
          `Error processing messageTimestamp: ${error.message}, using current time`
        );
        messageTimestamp = Date.now();
      }

      // Check if this is a group message (we need to ignore these)
      const isGroupMessage = this.isGroupMessage(
        remoteJid,
        dataObject,
        webhookData
      );

      // Skip processing for group messages
      if (isGroupMessage) {
        this.logger.log(`Ignoring group message from ${remoteJid}`);
        return { success: true };
      }

      // Optional fields
      const dateTime = webhookData?.date_time
        ? new Date(webhookData.date_time)
        : new Date();
      const destination = webhookData?.destination || '';
      const sender = webhookData?.sender || '';
      const serverUrl = webhookData?.server_url || '';
      const apikey = webhookData?.apikey || '';

      // Extract message content based on message type
      let messageContent = '';
      try {
        const messageObj = dataObject?.message || {};

        if (!messageObj || Object.keys(messageObj).length === 0) {
          this.logger.warn(`Missing or empty message object in webhook data`);
        } else {
          this.logger.debug(
            `Message type: ${messageType}, Keys: ${Object.keys(messageObj).join(', ')}`
          );

          // Handle different message types
          if (messageType === 'conversation' && messageObj.conversation) {
            messageContent = messageObj.conversation;
            this.logger.debug(
              `Extracted conversation text: "${messageContent}"`
            );
          } else if (messageObj.extendedTextMessage?.text) {
            // Handle extended text messages (usually with formatting or links)
            messageContent = messageObj.extendedTextMessage.text;
            this.logger.debug(`Extracted extended text: "${messageContent}"`);
          } else if (messageObj.imageMessage?.caption) {
            // Handle image with caption
            messageContent = messageObj.imageMessage.caption;
            this.logger.debug(
              `Extracted image caption: "${messageContent}" (Image message)`
            );
          } else if (messageObj.videoMessage?.caption) {
            // Handle video with caption
            messageContent = messageObj.videoMessage.caption;
            this.logger.debug(
              `Extracted video caption: "${messageContent}" (Video message)`
            );
          } else if (messageObj.documentMessage?.caption) {
            // Handle document with caption
            messageContent = messageObj.documentMessage.caption;
            this.logger.debug(
              `Extracted document caption: "${messageContent}" (Document message)`
            );
          } else if (messageObj.audioMessage) {
            // Handle audio message (typically no text)
            messageContent = '(Audio message)';
            this.logger.debug(`Received audio message without text`);
          } else if (messageObj.stickerMessage) {
            // Handle sticker message
            messageContent = '(Sticker)';
            this.logger.debug(`Received sticker message`);
          } else if (
            messageObj.contactMessage ||
            messageObj.contactsArrayMessage
          ) {
            // Handle contact share
            messageContent = '(Contact shared)';
            this.logger.debug(`Received contact message`);
          } else if (messageObj.locationMessage) {
            // Handle location share
            const loc = messageObj.locationMessage;
            const hasName = loc.name && loc.name.trim() !== '';
            messageContent = hasName
              ? `(Location: ${loc.name})`
              : '(Location shared)';
            this.logger.debug(`Received location message: ${messageContent}`);
          } else {
            // Unknown message type
            this.logger.warn(
              `Unknown message type encountered, message keys: ${Object.keys(messageObj).join(', ')}`
            );
            messageContent = '(Message received)';
          }
        }
      } catch (error) {
        this.logger.error(
          `Error extracting message content: ${error.message}`,
          error.stack
        );
        messageContent = '(Message content extraction failed)';
      }

      // Log the received data for debugging
      this.logger.debug(
        `Processing webhook: ${event} for channel ${channel.id} with message: "${messageContent}"`
      );

      // Build the webhook event data object
      const webhookEventData = {
        event: event,
        instance: instance,
        instanceId: instanceId,
        rawData: dataObject,
        remoteJid: remoteJid,
        fromMe: fromMe,
        messageId: messageId,
        pushName: pushName,
        messageType: messageType,
        messageContent: messageContent,
        messageTimestamp: BigInt(messageTimestamp),
        dateTime: dateTime,
        destination: destination,
        sender: sender,
        serverUrl: serverUrl,
        apikey: apikey,
        channel: {
          connect: {
            id: channel.id,
          },
        },
      };

      // Log for debugging
      this.logger.debug(
        `Preparing to save webhook event: ${JSON.stringify({
          event,
          instance,
          messageType,
          messageContent: messageContent?.substring(0, 50),
          remoteJid,
        })}`
      );

      // Save the webhook event with all necessary safety checks
      let webhookEvent;
      try {
        webhookEvent = await this.prisma.webhookEvent.create({
          data: webhookEventData,
        });

        this.logger.log(
          `Webhook event saved successfully with ID: ${webhookEvent.id}`
        );

        // Process the webhook to create or update a chat
        this.logger.log(`Processing webhook event ID: ${webhookEvent.id}`);
        await this.processWebhookEvent(webhookEvent.id);
      } catch (error) {
        this.logger.error(
          `Failed to save webhook event: ${error.message}`,
          error.stack
        );

        // Try to save a simplified version without the raw data if it might be too large
        if (
          error.message.includes('too large') ||
          error.message.includes('size exceeds')
        ) {
          this.logger.warn(
            `Attempting to save webhook event without raw data due to size constraints`
          );
          try {
            const simplifiedData = {
              ...webhookEventData,
              rawData: { message_too_large: true },
            };
            webhookEvent = await this.prisma.webhookEvent.create({
              data: simplifiedData,
            });

            this.logger.log(
              `Simplified webhook event saved with ID: ${webhookEvent.id}`
            );

            // Process the webhook to create or update a chat
            this.logger.log(
              `Processing simplified webhook event ID: ${webhookEvent.id}`
            );
            await this.processWebhookEvent(webhookEvent.id);
          } catch (innerError) {
            this.logger.error(
              `Failed to save simplified webhook event: ${innerError.message}`,
              innerError.stack
            );
            throw innerError; // Re-throw to be caught by outer catch
          }
        } else {
          // Re-throw original error if it's not related to size
          throw error;
        }
      }

      return { success: true };
    } catch (error) {
      this.logger.error(
        `Error processing webhook channel data: ${error.message}`,
        error.stack
      );
      return { success: false };
    }
  }

  /**
   * Test method to send a WhatsApp message using Evolution API
   * @param agentId Agent ID to use for sending the message
   * @param phone WhatsApp phone number to send to (with country code)
   * @param message Message text to send
   */
  async testSendMessage(
    agentId: string,
    phone: string,
    message: string
  ): Promise<any> {
    this.logger.log(
      `Testing WhatsApp message to ${phone} via agent ${agentId}`
    );

    // Check if the agent is active
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { isActive: true },
    });

    if (agent?.isActive === false) {
      this.logger.warn(
        `Cannot send test message - agent ${agentId} is inactive`
      );
      throw new Error('Agent is inactive and cannot send messages');
    }

    // Send message via the Evolution API service and return the response
    const response = await this.evolutionApiService.sendWhatsAppMessage(
      agentId,
      phone,
      message
    );

    this.logger.log(`Message sent to ${phone}, response received`);
    return response;
  }
}
