import { Module } from '@nestjs/common';
import { EvolutionApiService } from './evolution-api.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [EvolutionApiService],
  exports: [EvolutionApiService],
})
export class EvolutionApiModule {}
