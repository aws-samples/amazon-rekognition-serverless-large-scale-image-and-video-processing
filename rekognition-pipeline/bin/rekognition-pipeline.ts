#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RekognitionPipelineStack } from '../lib/rekognition-pipeline-stack';

const app = new cdk.App();
new RekognitionPipelineStack(app, 'RekognitionPipelineStack');
