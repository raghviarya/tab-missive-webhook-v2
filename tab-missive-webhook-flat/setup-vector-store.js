#!/usr/bin/env node

/**
 * Setup script to create a vector store and upload files for file search
 * Run this with: node setup-vector-store.js
 */

const fs = require('fs');
const path = require('path');

// You'll need to install the OpenAI package first:
// npm install openai

const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function createVectorStore() {
  try {
    console.log('🚀 Creating vector store...');
    
    // Create vector store
    const vectorStore = await openai.vectorStores.create({
      name: "tab_knowledge_base"
    });
    
    console.log('✅ Vector store created!');
    console.log('📋 VECTOR_STORE_ID:', vectorStore.id);
    console.log('');
    
    return vectorStore.id;
  } catch (error) {
    console.error('❌ Error creating vector store:', error.message);
    throw error;
  }
}

async function uploadFileToVectorStore(vectorStoreId, filePath) {
  try {
    console.log(`📁 Uploading file: ${filePath}`);
    
    // Upload file
    const file = await openai.files.create({
      file: fs.createReadStream(filePath),
      purpose: "assistants"
    });
    
    console.log(`✅ File uploaded with ID: ${file.id}`);
    
    // Add to vector store
    await openai.vectorStores.files.create(vectorStoreId, {
      file_id: file.id
    });
    
    console.log(`✅ File added to vector store`);
    return file.id;
  } catch (error) {
    console.error(`❌ Error uploading ${filePath}:`, error.message);
    throw error;
  }
}

async function checkVectorStoreStatus(vectorStoreId) {
  try {
    console.log('🔍 Checking vector store status...');
    console.log('Vector Store ID:', vectorStoreId, 'Type:', typeof vectorStoreId);
    
    const files = await openai.vectorStores.files.list({
      vector_store_id: String(vectorStoreId)
    });
    
    console.log(`📊 Vector store has ${files.data.length} files:`);
    files.data.forEach(file => {
      console.log(`  - ${file.id} (status: ${file.status})`);
    });
    
    return files.data;
  } catch (error) {
    console.error('❌ Error checking vector store:', error.message);
    throw error;
  }
}

async function main() {
  console.log('🎯 Tab Vector Store Setup');
  console.log('========================');
  console.log('');
  
  // Check if API key is set
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY environment variable not set!');
    console.log('Please set it with: export OPENAI_API_KEY=your_api_key');
    process.exit(1);
  }
  
  try {
    // Step 1: Create vector store
    const vectorStoreId = await createVectorStore();
    
    // Step 2: Upload files
    const filesToUpload = [
      './knowledge/Canned responses.pdf',
      './knowledge/Fin context.pdf'
    ];
    
    if (filesToUpload.length > 0) {
      console.log('📤 Uploading files...');
      for (const filePath of filesToUpload) {
        if (fs.existsSync(filePath)) {
          await uploadFileToVectorStore(vectorStoreId, filePath);
        } else {
          console.log(`⚠️  File not found: ${filePath}`);
        }
      }
    } else {
      console.log('ℹ️  No files specified for upload.');
      console.log('   Edit this script to add your file paths in the filesToUpload array.');
    }
    
    // Step 3: Check status (optional)
    try {
      await checkVectorStoreStatus(vectorStoreId);
    } catch (error) {
      console.log('⚠️  Status check failed, but vector store was created successfully');
    }
    
    console.log('');
    console.log('🎉 Setup complete!');
    console.log('');
    console.log('📋 Next steps:');
    console.log('1. Add this to your Vercel environment variables:');
    console.log(`   VECTOR_STORE_ID=${vectorStoreId}`);
    console.log('');
    console.log('2. If you need to upload more files later, run this script again');
    console.log('   and add the file paths to the filesToUpload array.');
    console.log('');
    console.log('3. Deploy your webhook and test!');
    
  } catch (error) {
    console.error('💥 Setup failed:', error.message);
    process.exit(1);
  }
}

// Run the setup
main();
