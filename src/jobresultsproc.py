import json
import os
import boto3
import time
from helper import AwsHelper, S3Helper
import datastore

def getJobResults(api, jobId):

    pages = []

    time.sleep(5)

    client = AwsHelper().getClient('rekognition')
    if(api == "StartLabelDetection"):
        response = client.get_label_detection(JobId=jobId)
    elif (api == "StartTextDetection"):
        response = client.get_text_detection(JobId=jobId)
    elif (api == "StartFaceDetection"):
        response = client.get_face_detection(JobId=jobId)
    elif (api == "StartContentModeration"):
        response = client.get_content_moderation(JobId=jobId)
    elif (api == "StartCelebrityRecognition"):
        response = client.get_celebrity_recognition(JobId=jobId)
    
    pages.append(response)
    print("Resultset received: {}".format(len(pages)))
    nextToken = None
    if('NextToken' in response):
        nextToken = response['NextToken']
        print("Next token: {}".format(nextToken))

    while(nextToken):
        time.sleep(5)
        
        if(api == "StartLabelDetection"):
            response = client.get_label_detection(JobId=jobId, NextToken=nextToken)
        elif (api == "StartTextDetection"):
            response = client.get_text_detection(JobId=jobId, NextToken=nextToken)
        elif (api == "StartFaceDetection"):
            response = client.get_face_detection(JobId=jobId, NextToken=nextToken)
        elif (api == "StartContentModeration"):
            response = client.get_content_moderation(JobId=jobId, NextToken=nextToken)
        elif (api == "StartCelebrityRecognition"):
            response = client.get_celebrity_recognition(JobId=jobId, NextToken=nextToken)

        pages.append(response)
        print("Resultset received: {}".format(len(pages)))
        nextToken = None
        if('NextToken' in response):
            nextToken = response['NextToken']
            print("Next token: {}".format(nextToken))

    return pages

def processRequest(request):

    output = ""

    print(request)

    jobId = request['jobId']
    jobTag = request['jobTag']
    jobStatus = request['jobStatus']
    jobAPI = request['jobAPI']
    bucketName = request['bucketName']
    objectName = request['objectName']
    outputBucket = request["outputBucket"]
    itemsTable = request["itemsTable"]

    pages = getJobResults(jobAPI, jobId)

    print("Result pages received: {}".format(len(pages)))
    print(pages)

    outputPath = "async/{}-analysis/{}/".format(objectName, jobTag)
    opath = "{}response.json".format(outputPath)
    S3Helper.writeToS3(json.dumps(pages), outputBucket, opath)

    #opg = OutputGenerator(jobTag, pages, bucketName, objectName, ddb)
    #opg.run()

    print("ItemId: {}".format(jobTag))

    ds = datastore.ItemStore(itemsTable)
    ds.markItemComplete(jobTag)

    output = "Processed -> Item: {}, Object: {}/{} processed.".format(jobTag, bucketName, objectName)

    print(output)

    return {
        'statusCode': 200,
        'body': output
    }

def lambda_handler(event, context):

    print("event: {}".format(event))

    body = json.loads(event['Records'][0]['body'])
    message = json.loads(body['Message'])

    print("Message: {}".format(message))

    request = {}

    request["jobId"] = message['JobId']
    request["jobTag"] = message['JobTag']
    request["jobStatus"] = message['Status']
    request["jobAPI"] = message['API']
    request["bucketName"] = message['Video']['S3Bucket']
    request["objectName"] = message['Video']['S3ObjectName']
    
    request["outputBucket"] = os.environ['OUTPUT_BUCKET']
    request["itemsTable"] = os.environ['ITEMS_TABLE']

    return processRequest(request)

def lambda_handler_local(event, context):
    print("event: {}".format(event))
    return processRequest(event)

