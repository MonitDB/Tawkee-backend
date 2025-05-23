import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { CreditSpentResponseDto } from './dto/credit-spent-response.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { EnhancedAgentDto } from './dto/enhanced-agent.dto';
import { GroupingTime, AIModel } from '@prisma/client';

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspacesService: WorkspacesService
  ) {}

  async findAll(workspaceId: string, paginationDto: PaginationDto) {
    // Ensure the workspace exists
    await this.workspacesService.findOne(workspaceId);

    const { page, pageSize, query } = paginationDto;

    const skip = (page - 1) * pageSize;

    const where = {
      workspaceId,
      ...(query
        ? { name: { contains: query, mode: 'insensitive' as any } }
        : {}),
    };

    // Get total count for pagination metadata
    const total = await this.prisma.agent.count({ where });

    // Calculate total pages
    const totalPages = Math.ceil(total / pageSize);

    const agents = await this.prisma.agent.findMany({
      where,
      skip,
      take: pageSize,
      select: {
        id: true,
        workspaceId: true,
        name: true,
        behavior: true,
        avatar: true,
        communicationType: true,
        type: true,
        jobName: true,
        jobSite: true,
        jobDescription: true,
        isActive: true,
        settings: {
          select: {
            preferredModel: true,
            timezone: true,
            enabledHumanTransfer: true,
            enabledReminder: true,
            splitMessages: true,
            enabledEmoji: true,
            limitSubjects: true,
            messageGroupingTime: true,
          },
        },
        webhooks: {
          select: {
            onNewMessage: true,
            onLackKnowLedge: true,
            onTransfer: true,
            onFinishAttendance: true,
          },
        },
        channels: {
          select: {
            id: true,
            name: true,
            type: true,
            connected: true,
            config: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    // Transform the data to match the EnhancedAgentDto structure
    const enhancedAgents = agents.map((agent) => {
      // Destructure the agent object including channels
      const { settings, webhooks, channels, ...agentData } = agent as any;

      return {
        agent: {
          ...agentData,
          channels: channels || [],
        },
        settings: settings || {
          preferredModel: AIModel.GPT_4_1,
          timezone: 'UTC',
          enabledHumanTransfer: true,
          enabledReminder: true,
          splitMessages: true,
          enabledEmoji: true,
          limitSubjects: true,
          messageGroupingTime: GroupingTime.NO_GROUP,
        },
        webhooks: webhooks || {
          onNewMessage: null,
          onLackKnowLedge: null,
          onTransfer: null,
          onFinishAttendance: null,
        },
      };
    });

    return {
      data: enhancedAgents,
      meta: {
        total,
        page,
        pageSize,
        totalPages,
      },
    };
  }

  async create(
    workspaceId: string,
    createAgentDto: CreateAgentDto
  ): Promise<EnhancedAgentDto> {
    // Ensure the workspace exists
    await this.workspacesService.findOne(workspaceId);

    // Use a transaction to create the agent and related data
    const result = await this.prisma.$transaction(async (tx) => {
      // Create the agent first
      const agent = await tx.agent.create({
        data: {
          ...createAgentDto,
          workspaceId,
        },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          behavior: true,
          avatar: true,
          communicationType: true,
          type: true,
          jobName: true,
          jobSite: true,
          jobDescription: true,
          isActive: true,
        },
      });

      // Create agent settings
      const settings = await tx.agentSettings.create({
        data: {
          agentId: agent.id,
          preferredModel: AIModel.GPT_4_1,
          timezone: 'UTC',
          enabledHumanTransfer: true,
          enabledReminder: true,
          splitMessages: true,
          enabledEmoji: true,
          limitSubjects: true,
          messageGroupingTime: GroupingTime.NO_GROUP,
        },
      });

      // Create agent webhooks
      const webhooks = await tx.agentWebhooks.create({
        data: {
          agentId: agent.id,
          onNewMessage: null,
          onLackKnowLedge: null,
          onTransfer: null,
          onFinishAttendance: null,
        },
      });

      return { agent, settings, webhooks };
    });

    // Return the combined data as EnhancedAgentDto
    return {
      agent: {
        ...result.agent,
        channels: [], // Add empty channels array for newly created agents
      },
      settings: {
        preferredModel: result.settings.preferredModel,
        timezone: result.settings.timezone,
        enabledHumanTransfer: result.settings.enabledHumanTransfer,
        enabledReminder: result.settings.enabledReminder,
        splitMessages: result.settings.splitMessages,
        enabledEmoji: result.settings.enabledEmoji,
        limitSubjects: result.settings.limitSubjects,
        messageGroupingTime: result.settings.messageGroupingTime,
      },
      webhooks: {
        onNewMessage: result.webhooks.onNewMessage,
        onLackKnowLedge: result.webhooks.onLackKnowLedge,
        onTransfer: result.webhooks.onTransfer,
        onFinishAttendance: result.webhooks.onFinishAttendance,
      },
    };
  }

  async findOne(id: string): Promise<EnhancedAgentDto> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        behavior: true,
        avatar: true,
        communicationType: true,
        type: true,
        jobName: true,
        jobSite: true,
        jobDescription: true,
        isActive: true,
        settings: {
          select: {
            preferredModel: true,
            timezone: true,
            enabledHumanTransfer: true,
            enabledReminder: true,
            splitMessages: true,
            enabledEmoji: true,
            limitSubjects: true,
            messageGroupingTime: true,
          },
        },
        webhooks: {
          select: {
            onNewMessage: true,
            onLackKnowLedge: true,
            onTransfer: true,
            onFinishAttendance: true,
          },
        },
        channels: {
          select: {
            id: true,
            name: true,
            type: true,
            connected: true,
            config: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!agent) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }

    // Extract and format the data
    const { settings, webhooks, channels, ...agentData } = agent as any;

    // Return the combined data in EnhancedAgentDto format
    return {
      agent: {
        ...agentData,
        channels: channels || [],
      },
      settings: settings || {
        preferredModel: AIModel.GPT_4_1,
        timezone: 'UTC',
        enabledHumanTransfer: true,
        enabledReminder: true,
        splitMessages: true,
        enabledEmoji: true,
        limitSubjects: true,
        messageGroupingTime: GroupingTime.NO_GROUP,
      },
      webhooks: webhooks || {
        onNewMessage: null,
        onLackKnowLedge: null,
        onTransfer: null,
        onFinishAttendance: null,
      },
    };
  }

  async update(
    id: string,
    updateAgentDto: UpdateAgentDto
  ): Promise<EnhancedAgentDto> {
    // Ensure agent exists
    await this.findOne(id);

    // Update the agent first
    const updatedAgent = await this.prisma.agent.update({
      where: { id },
      data: updateAgentDto,
      select: {
        id: true,
        workspaceId: true,
        name: true,
        behavior: true,
        avatar: true,
        communicationType: true,
        type: true,
        jobName: true,
        jobSite: true,
        jobDescription: true,
        isActive: true,
      },
    });

    // Fetch the agent's settings
    const settings = await this.prisma.agentSettings.findUnique({
      where: { agentId: id },
      select: {
        preferredModel: true,
        timezone: true,
        enabledHumanTransfer: true,
        enabledReminder: true,
        splitMessages: true,
        enabledEmoji: true,
        limitSubjects: true,
        messageGroupingTime: true,
      },
    });

    // Fetch the agent's webhooks
    const webhooks = await this.prisma.agentWebhooks.findUnique({
      where: { agentId: id },
      select: {
        onNewMessage: true,
        onLackKnowLedge: true,
        onTransfer: true,
        onFinishAttendance: true,
      },
    });

    // Return the combined data as EnhancedAgentDto
    return {
      agent: updatedAgent,
      settings: settings || {
        preferredModel: AIModel.GPT_4_1,
        timezone: 'UTC',
        enabledHumanTransfer: true,
        enabledReminder: true,
        splitMessages: true,
        enabledEmoji: true,
        limitSubjects: true,
        messageGroupingTime: GroupingTime.NO_GROUP,
      },
      webhooks: webhooks || {
        onNewMessage: null,
        onLackKnowLedge: null,
        onTransfer: null,
        onFinishAttendance: null,
      },
    };
  }

  async remove(id: string): Promise<{ success: boolean; message?: string }> {
    // Ensure agent exists
    await this.findOne(id);

    try {
      // Check if there are any related chats
      const relatedChats = await this.prisma.chat.count({
        where: { agentId: id },
      });

      if (relatedChats > 0) {
        return {
          success: false,
          message: `Cannot delete this agent because it has ${relatedChats} associated chat(s). You must delete these chats first.`,
        };
      }

      // Check if there are any related interactions
      const relatedInteractions = await this.prisma.interaction.count({
        where: { agentId: id },
      });

      if (relatedInteractions > 0) {
        return {
          success: false,
          message: `Cannot delete this agent because it has ${relatedInteractions} associated interaction(s). You must delete these interactions first.`,
        };
      }

      // If there are no related records, delete the agent
      await this.prisma.agent.delete({
        where: { id },
      });

      return { success: true, message: 'Agent deleted successfully' };
    } catch (error) {
      // Handle unexpected errors
      if (error.code === 'P2003') {
        // This is a Prisma foreign key constraint error
        const constraintMatch = error.message.match(/`([^`]+)`$/);
        const constraintName = constraintMatch ? constraintMatch[1] : 'unknown';

        return {
          success: false,
          message: `Cannot delete this agent because it is referenced by other records (constraint: ${constraintName}). You must delete the dependent records first.`,
        };
      }

      // Re-throw other errors to be handled by the global error handler
      throw error;
    }
  }

  async deactivate(id: string): Promise<{ success: boolean }> {
    // Ensure agent exists
    await this.findOne(id);

    await this.prisma.agent.update({
      where: { id },
      data: { isActive: false },
    });

    return { success: true };
  }

  async activate(id: string): Promise<{ success: boolean }> {
    // Ensure agent exists
    await this.findOne(id);

    await this.prisma.agent.update({
      where: { id },
      data: { isActive: true },
    });

    return { success: true };
  }

  async getCreditsSpent(id: string): Promise<CreditSpentResponseDto> {
    // Ensure agent exists
    await this.findOne(id);

    const creditSpent = await this.prisma.creditSpent.findMany({
      where: { agentId: id },
      select: {
        credits: true,
        year: true,
        month: true,
        day: true,
        model: true,
      },
    });

    const total = creditSpent.reduce((sum, item) => sum + item.credits, 0);

    return {
      total,
      data: creditSpent,
    };
  }
}
