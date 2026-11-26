import { Global, Module } from '@nestjs/common';
import { SecretsController } from './secrets.controller';
import { SecretVaultService } from './secret-vault.service';

@Global()
@Module({ controllers: [SecretsController], providers: [SecretVaultService], exports: [SecretVaultService] })
export class SecretsModule {}
